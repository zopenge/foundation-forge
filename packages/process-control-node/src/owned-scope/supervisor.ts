import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { OwnedProcessCompletion, OwnedProcessLaunchRequest, OwnedProcessOutput, OwnedProcessScope, ProcessIdentity, ProcessScopeClosure } from '@openge/forge-process-control';
import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';
import { frame, object, readFrame, supervisorEnvironment, validateLaunch, type ScopeKey } from './protocol.js';
import type { ScopeBackend } from './backend.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
export interface SupervisorPort {
  readonly boot: Promise<void>;
  readonly startupSignal: AbortSignal;
  readonly terminationTimeoutMs: number;
  assertRootInstance(pid: number): void;
  rpc(type: string, payload?: unknown): Promise<Record<string, unknown>>;
}
export function startSupervisor(input: OwnedProcessLaunchRequest, platform: 'win32' | 'linux',
  createBackend: (port: SupervisorPort) => Promise<ScopeBackend>, output?: (event: OwnedProcessOutput) => void): OwnedProcessScope {
  validateLaunch(input);
  const request = Object.freeze({ ...input, args: Object.freeze([...(input.args ?? [])]), environment: Object.freeze({ ...input.environment }) });
  const key: ScopeKey = { scopeId: randomUUID(), binding: request.binding, nonce: randomUUID() };
  const root = deferred<number>(), completion = deferred<OwnedProcessCompletion>(), boot = deferred<undefined>(), closed = deferred<undefined>();
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  let child: ChildProcess | undefined, backend: ScopeBackend | undefined, identity: ProcessIdentity | undefined;
  let outgoing = 0, incoming = 0, requestId = 0, bound = false, authorized = false, rootExited = false, done = false;
  let helperExit: { code: number | null; signal: string | null } | undefined;
  let directExit: { exitCode: number | null; signal: string | null } | undefined, finishing: Promise<void> | undefined;
  let finalReason: ProcessScopeClosure['reason'] = 'normal';
  const scopeError = (reason: string) => new ProcessControlError(processControlErrorCodes.scopeUnknown, { reason });
  const active = (signal?: AbortSignal) => { if (signal?.aborted || finishing || done) throw scopeError('INACTIVE'); };
  const rpc: SupervisorPort['rpc'] = (type, payload) => {
    if (!child?.connected) return Promise.reject(scopeError('CHANNEL_CLOSED'));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(scopeError('CONTROL_DEADLINE')); }, type === 'stop' || type === 'finish' || type === 'inspect' ? request.terminationTimeoutMs : request.startupTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child?.send(frame(key, ++outgoing, type, payload, id), error => {
        if (error) { const item = pending.get(id); if (item) { clearTimeout(item.timer); pending.delete(id); item.reject(scopeError('CONTROL_SEND')); } }
      });
    });
  };
  const startupController = new AbortController();
  const port: SupervisorPort = { boot: boot.promise, startupSignal: startupController.signal, terminationTimeoutMs: request.terminationTimeoutMs, rpc,
    assertRootInstance: pid => {
      if (!child || child.pid !== pid || child.exitCode !== null || child.signalCode !== null || rootExited || !child.connected) throw scopeError('ROOT_INSTANCE');
    } };
  const startup = setTimeout(() => { startupController.abort(); boot.reject(scopeError('BOOT_DEADLINE')); void finish('provider-failed'); }, request.startupTimeoutMs);
  const waitClose = async () => {
    if (!child || rootExited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed.promise, new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(scopeError('CLOSE_DEADLINE')), request.terminationTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  const finish = (reason: ProcessScopeClosure['reason']): Promise<void> => {
    if (finishing) return finishing;
    finalReason = reason;
    finishing = (async () => {
      let empty: boolean | undefined;
      clearTimeout(startup);
      if (reason !== 'normal') { startupController.abort(); boot.reject(scopeError('STOPPED')); }
      try {
        await initialization;
        if (reason === 'normal') {
          if (!backend || !identity || !authorized || !directExit) throw scopeError('MISSING_CLOSURE');
          // 直接作业已 close；仍有成员就是前台契约违反，不能等待它自行结束后升级为正常。
          if (!await backend.empty(false)) { finalReason = 'descendants-remained'; await backend.force(); }
          else await rpc('finish');
        } else await backend?.force();
        if (!rootExited && finalReason !== 'normal' && child && (platform === 'win32' || !backend)) child.kill('SIGKILL');
        await waitClose();
        if (finalReason === 'normal' && (helperExit?.code !== 0 || helperExit.signal !== null)) finalReason = 'owner-lost';
        if (backend) empty = await backend.empty(true);
        if (empty !== true) finalReason = finalReason === 'normal' ? 'provider-failed' : finalReason;
      } catch {
        if (finalReason === 'normal') finalReason = 'provider-failed';
        try { await backend?.force(); } catch { /* 仍保留未知，关闭 Job 句柄会执行其生命周期策略。 */ }
        if (!rootExited && (platform === 'win32' || !backend)) child?.kill('SIGKILL');
        try { await waitClose(); if (backend) empty = await backend.empty(true); } catch { empty = undefined; }
      } finally {
        try { await backend?.dispose(); } catch { finalReason = 'provider-failed'; empty = undefined; }
        done = true;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(scopeError('FINISHED')); } pending.clear();
        boot.reject(scopeError('FINISHED')); root.reject(scopeError('NOT_STARTED'));
        child?.stdout?.removeAllListeners('data'); child?.stderr?.removeAllListeners('data');
        child?.stdout?.destroy(); child?.stderr?.destroy();
        if (child?.connected) child.disconnect(); child?.unref();
        const base = { scopeId: key.scopeId, binding: key.binding, observedAt: new Date().toISOString() };
        const closure: ProcessScopeClosure = finalReason === 'normal' && identity && empty === true
          ? { ...base, status: 'closed', reason: 'normal', rootIdentity: identity, empty: true }
          : { ...base, status: 'unknown', reason: finalReason === 'normal' ? 'provider-failed' : finalReason, ...(identity ? { rootIdentity: identity } : {}), ...(empty === undefined ? {} : { empty }) };
        completion.resolve({ exitCode: directExit?.exitCode ?? null, signal: directExit?.signal ?? null, closure });
      }
    })();
    return finishing;
  };
  const initialization = (async () => {
    backend = await createBackend(port);
    if (finishing) throw scopeError('STOPPED');
    child = spawn(process.execPath, [fileURLToPath(new URL('./scope-host.js', import.meta.url)), platform, key.scopeId, key.binding, key.nonce, String(request.terminationTimeoutMs)], {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: supervisorEnvironment(request.environment), detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
    });
    const forward = (stream: 'stdout' | 'stderr', chunk: Uint8Array) => { try { output?.({ stream, chunk: Uint8Array.from(chunk) }); } catch { void finish('provider-failed'); } };
    child.stdout?.on('data', (chunk: Uint8Array) => forward('stdout', chunk)); child.stderr?.on('data', (chunk: Uint8Array) => forward('stderr', chunk));
    child.on('message', value => {
      if (done) return;
      try {
        const message = readFrame(value, key, ++incoming);
        if (message.type === 'ready' && incoming === 1) boot.resolve(undefined);
        else if (message.type === 'response' && message.id !== undefined) {
          const item = pending.get(message.id); if (!item) throw scopeError('UNEXPECTED_REPLY');
          clearTimeout(item.timer); pending.delete(message.id);
          const result = object(message.payload); if (result.ok !== true) item.reject(scopeError('HELPER_REJECTED')); else item.resolve(result);
        } else if (message.type === 'direct-exit' && authorized && !directExit) {
          const value = object(message.payload);
          if ((value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) || (value.signal !== null && typeof value.signal !== 'string')) throw scopeError('EXIT_PROTOCOL');
          directExit = { exitCode: typeof value.exitCode === 'number' ? value.exitCode : null, signal: typeof value.signal === 'string' ? value.signal : null };
          void finish('normal');
        } else throw scopeError('UNEXPECTED_MESSAGE');
      } catch { boot.reject(scopeError('PROTOCOL')); void finish('provider-failed'); }
    });
    child.once('error', () => { boot.reject(scopeError('HELPER_START')); root.reject(scopeError('HELPER_START')); void finish('provider-failed'); });
    child.once('close', (code, signal) => { helperExit = { code, signal }; rootExited = true; closed.resolve(undefined); if (!finishing) { boot.reject(scopeError('OWNER_LOST')); void finish('owner-lost'); } });
    await new Promise<void>((resolve, reject) => { child?.once('spawn', resolve); child?.once('error', reject); });
    if (child.pid === undefined) throw scopeError('MISSING_ROOT_PID');
    await backend.attach(child.pid); await boot.promise;
    if (finishing) throw scopeError('STOPPED');
    clearTimeout(startup);
    root.resolve(child.pid);
  })().catch(error => { boot.reject(error); root.reject(error); void finish('provider-failed'); });
  return {
    scopeId: key.scopeId, rootPid: root.promise, completion: completion.promise,
    bind: async (value, signal) => {
      active(signal); await initialization; active(signal);
      if (bound) {
        if (identity?.pid !== value.pid || identity.startToken !== value.startToken) { void finish('provider-failed'); throw new ProcessControlError(processControlErrorCodes.scopeBinding); }
        return;
      }
      try { await backend?.bind(value); active(signal); identity = { pid: value.pid, startToken: value.startToken }; await rpc('bind'); active(signal); bound = true; }
      catch (error) { void finish('provider-failed'); throw error; }
    },
    authorize: async signal => {
      if (authorized && !finishing && !done) return;
      active(signal); if (!bound || !identity) throw new ProcessControlError(processControlErrorCodes.scopeBinding, { reason: 'NOT_BOUND' });
      authorized = true;
      try { await rpc('start', request); } catch (error) { void finish('provider-failed'); throw error; }
    },
    terminate: async policy => {
      if (policy.mode !== 'force') throw new ProcessControlError(processControlErrorCodes.scopeUnsupported, { reason: 'FORCE_REQUIRED' });
      await finish('terminated'); return (await completion.promise).closure;
    },
    dispose: async () => { if (!done) await finish('terminated'); },
  };
}
