import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { normalizeCommandSpec, type CommandEvent, type CommandResult, type CommandRunner, type CommandSpec } from '@openge/forge-command-runner';
import type { ProcessIdentity, ProcessScopeClosure } from '@openge/forge-process-control';

export interface ScriptedCommandCall {
  readonly command: string; readonly args: readonly string[]; readonly cwd: string;
  readonly stdout?: string; readonly exitCode?: number;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** 只提供协议组件输入；所有身份/closure 均为合成，禁止用作真实 OS 停止证据。
 * 不执行命令、探测 PID 或运行超时计时器；timeout 仅接受显式 terminate('timeout') 输入。 */
export function createScriptedCommandRunner({ calls }: { readonly calls: readonly ScriptedCommandCall[] }) {
  const script = calls.map(call => ({ ...call, args: [...call.args] }));
  const observed: CommandSpec[] = [], active = new Set<number>(), failures: unknown[] = [];
  let position = 0;
  const runner: CommandRunner = {
    run: async () => { throw new Error('SCRIPTED_DIRECT_RUN_FORBIDDEN'); },
    start: (input, observer) => {
      const spec = normalizeCommandSpec(input), scope = spec.ownedScope;
      if (!scope || scope.start !== 'manual') throw new Error('SCRIPTED_MANUAL_SCOPE_REQUIRED');
      const next = script[position];
      if (!next) throw new Error('SCRIPTED_UNEXPECTED_COMMAND');
      deepStrictEqual({ command: spec.command, args: spec.args, cwd: spec.cwd },
        { command: next.command, args: next.args, cwd: next.cwd }, 'SCRIPTED_COMMAND_ORDER');
      const output = Buffer.from(next.stdout ?? '');
      if (spec.heartbeatMs !== undefined || spec.output?.mode === 'ignore'
        || (spec.output?.mode === 'capture' && output.length > spec.output.maxBytesPerStream))
        throw new Error('SCRIPTED_UNSUPPORTED_OUTPUT_OR_HEARTBEAT');
      if (!Number.isSafeInteger(next.exitCode ?? 0) || (next.exitCode ?? 0) < 0) throw new Error('SCRIPTED_INVALID_EXIT_CODE');
      const id = ++position; observed.push(spec); active.add(id);
      // 超出 OS PID 范围，且 token 显式带 scripted 标记，不能送入真实 PID reader。
      const identity: ProcessIdentity = { pid: 4_294_967_296 + id, startToken: `scripted:protocol-only:${String(id)}` };
      const scopeId = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
      const ready = deferred<undefined>(), completed = deferred<CommandResult>();
      let initialized = false, finished = false, authorized = false, written = Buffer.alloc(0);
      let requested: 'abort' | 'timeout' | undefined;
      const cleanup = () => { active.delete(id); spec.signal?.removeEventListener('abort', onAbort); };
      const fail = (error: unknown) => {
        failures.push(error);
        if (finished) return;
        finished = true; cleanup(); ready.reject(error); completed.reject(error);
      };
      const emit = (event: CommandEvent) => { observer?.(event); };
      const finish = (reason: 'exit' | 'abort' | 'timeout') => {
        if (finished) return;
        finished = true; cleanup();
        const binding = { scopeId, binding: scope.binding, rootIdentity: identity, observedAt: new Date(0).toISOString(), empty: true as const };
        const closure: ProcessScopeClosure = reason === 'exit'
          ? { ...binding, status: 'closed', reason: 'normal' }
          : { ...binding, status: 'unknown', reason: 'terminated' };
        const result: CommandResult = { identity, exitCode: reason === 'exit' ? next.exitCode ?? 0 : null,
          signal: null, durationMs: 0, terminationReason: reason, diagnostics: [], ownedScope: closure,
          ...(spec.output?.mode === 'capture' ? { stdout: written, stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false } : {}) };
        try { emit({ type: 'exited', result }); completed.resolve(result); }
        catch (error) { failures.push(error); completed.reject(error); }
      };
      const stop = (reason: 'abort' | 'timeout') => {
        if (finished || requested) return;
        requested = reason;
        if (!initialized) return;
        try { emit({ type: 'termination-requested', reason }); finish(reason); } catch (error) { fail(error); }
      };
      const onAbort = () => { stop('abort'); };
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => {
        try {
          emit({ type: 'spawned', pid: identity.pid }); emit({ type: 'identified', identity });
          emit({ type: 'scope-ready', scopeId, binding: scope.binding, identity });
          initialized = true; ready.resolve(undefined);
          const reason = requested ?? (spec.signal?.aborted ? 'abort' : undefined);
          if (reason) { requested = undefined; stop(reason); }
        } catch (error) { fail(error); }
      });
      const pid = ready.promise.then(() => identity.pid), identityReady = ready.promise.then(() => identity);
      void pid.catch(() => {}); void identityReady.catch(() => {});
      return { pid, identity: identityReady, result: completed.promise,
        authorizeStart: async () => {
          await ready.promise;
          if (finished || requested || spec.signal?.aborted) throw new Error('SCRIPTED_INACTIVE_SCOPE');
          if (authorized) return;
          authorized = true;
          queueMicrotask(() => {
            if (finished) return;
            try { written = output; if (output.length > 0) emit({ type: 'stdout', chunk: Uint8Array.from(output) }); finish('exit'); }
            catch (error) { fail(error); }
          });
        },
        terminate: async (reason = 'abort') => { stop(reason); await completed.promise; },
      };
    },
  };
  return { runner, observed, evidence: 'synthetic-protocol-only' as const,
    assertConsumed: () => {
      strictEqual(position, script.length, 'SCRIPTED_UNCONSUMED_COMMANDS');
      strictEqual(active.size, 0, 'SCRIPTED_ACTIVE_COMMANDS');
      if (failures.length) throw new AggregateError(failures, 'SCRIPTED_OBSERVER_FAILURE');
    } };
}
