import { spawn, type ChildProcess } from 'node:child_process';
import type { OwnedProcessScope, ProcessIdentity, ProcessScopeClosure } from '@openge/forge-process-control';
import type { CommandDiagnostic, CommandErrorCode, CommandEvent, CommandObserver, CommandResult, CommandSpec, CommandTerminationReason, RunningCommand } from '../contracts.js';
import { CommandRunnerError } from '../errors.js';
import { normalizeCommandSpec } from '../normalize-spec.js';
import { CaptureBuffer } from './capture-buffer.js';
import { createEnvironment } from './environment.js';
import type { NodeCommandRunnerOptions } from './options.js';
import { acquireProcessIdentity } from './process-identity.js';
import { TimerScope } from './timers.js';
import { startOwnedAdapter } from './owned-process-adapter.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

type RequestedReason = 'abort' | 'timeout' | 'output-overflow';

export function startCommand(options: NodeCommandRunnerOptions, input: CommandSpec, observer?: CommandObserver): RunningCommand {
  const spec = normalizeCommandSpec(input);
  if (spec.ownedScope && (!options.ownedScopeProvider || options.terminationPolicy.mode !== 'force')) throw new CommandRunnerError('COMMAND_SCOPE_UNSUPPORTED', { reason: !options.ownedScopeProvider ? 'PROVIDER_REQUIRED' : 'FORCE_REQUIRED' });
  const pidState = deferred<number>();
  const identityState = deferred<ProcessIdentity | null>();
  const resultState = deferred<CommandResult>();
  const exitState = deferred<undefined>();
  void pidState.promise.catch(() => {});
  const scope = new TimerScope(options);
  const identityController = new AbortController();
  const closingScope = new TimerScope(options);
  const operationScopes = new Set<TimerScope>();
  const diagnostics: CommandDiagnostic[] = [];
  const now = options.now ?? Date.now;
  let child: ChildProcess | undefined;
  let owned: OwnedProcessScope | undefined, ownedClosure: ProcessScopeClosure | undefined;
  const ready = deferred<undefined>(); void ready.promise.catch(() => {});
  let authorization: Promise<void> | undefined;
  let startedAt: number | undefined;
  let identity: ProcessIdentity | null = null;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let exited = false;
  let closed = false;
  let finished = false;
  let reason: CommandTerminationReason | undefined;
  let termination: Promise<void> | undefined;
  let terminationPending = false;
  let cleanupAttempted = false;
  const stdout = spec.output?.mode === 'capture' ? new CaptureBuffer(spec.output.maxBytesPerStream) : undefined;
  const stderr = spec.output?.mode === 'capture' ? new CaptureBuffer(spec.output.maxBytesPerStream) : undefined;

  const diagnose = (code: CommandErrorCode, details: Readonly<Record<string, unknown>> = {}, cause?: unknown) => {
    if (Object.isFrozen(diagnostics)) return;
    if (!diagnostics.some(value => value.code === code)) diagnostics.push(Object.freeze({ code, details, ...(cause === undefined ? {} : { cause }) }));
  };
  const emit = (event: CommandEvent) => {
    try { observer?.(event); } catch (cause) {
      diagnose('COMMAND_OBSERVER_FAILED', { eventType: event.type }, cause);
      if (owned && event.type !== 'exited') void requestTermination('abort');
    }
  };
  const onAbort = () => { void requestTermination('abort'); };
  const finish = () => {
    if (finished) return;
    if (owned && !ownedClosure) { reason = 'termination-failure'; diagnose('COMMAND_SCOPE_UNKNOWN', { stage: 'missing-completion' }); }
    finished = true;
    scope.clear();
    closingScope.clear();
    for (const operation of operationScopes) operation.clear();
    spec.signal?.removeEventListener('abort', onAbort);
    identityController.abort();
    ready.reject(new CommandRunnerError('COMMAND_SCOPE_FAILED', { reason: 'FINISHED' }));
    exitState.resolve(undefined);
    identityState.resolve(identity);
    child?.stdout?.removeListener('data', onStdout);
    child?.stderr?.removeListener('data', onStderr);
    child?.removeListener('spawn', onSpawn);
    child?.removeListener('exit', onExit);
    child?.removeListener('close', onClose);
    child?.removeListener('error', onError);
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    child?.unref();
    const result: CommandResult = Object.freeze({
      identity, exitCode, signal: exitSignal,
      durationMs: startedAt === undefined ? 0 : Math.max(0, now() - startedAt),
      terminationReason: reason ?? (exitSignal === null ? 'exit' : 'signal'),
      ...(stdout === undefined || stderr === undefined ? {} : {
        stdout: stdout.bytes(), stderr: stderr.bytes(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
      }),
      diagnostics,
      ...(ownedClosure === undefined ? {} : { ownedScope: ownedClosure }),
    });
    emit({ type: 'exited', result });
    Object.freeze(diagnostics);
    resultState.resolve(result);
  };
  const directCleanup = () => {
    if (owned) { void owned.terminate({ mode: 'force' }).catch(cause => diagnose('COMMAND_SCOPE_FAILED', { stage: 'cleanup' }, cause)); return; }
    if (child?.pid === undefined || exited || cleanupAttempted) return;
    cleanupAttempted = true;
    try {
      if (!child.kill('SIGKILL')) diagnose('COMMAND_TERMINATION_FAILED', { stage: 'direct-child-cleanup' });
    } catch (cause) { diagnose('COMMAND_TERMINATION_FAILED', { stage: 'direct-child-cleanup' }, cause); }
  };
  const failTermination = (stage: string, cause?: unknown) => {
    reason = 'termination-failure';
    diagnose('COMMAND_TERMINATION_FAILED', { stage }, cause);
    directCleanup();
  };
  const requestTermination = (requested: RequestedReason): Promise<void> => {
    if (termination !== undefined) return termination;
    if (finished || (exited && !owned)) return Promise.resolve();
    const completion = deferred<undefined>();
    termination = completion.promise;
    reason = requested;
    terminationPending = true;
    emit({ type: 'termination-requested', reason: requested });
    const operationScope = new TimerScope(options);
    operationScopes.add(operationScope);
    const controller = new AbortController();
    const deadline = operationScope.delay(options.terminationTimeoutMs).then(() => ({ type: 'deadline' as const }));
    void (async () => {
      try {
        if (owned) {
          const operation = owned.terminate({ mode: 'force' }).then(() => ({ type: 'terminated' as const }), (cause: unknown) => ({ type: 'failed' as const, cause }));
          const outcome = await Promise.race([operation, deadline]);
          if (outcome.type !== 'terminated') { failTermination(outcome.type === 'deadline' ? 'scope-deadline' : 'scope-provider', outcome.type === 'failed' ? outcome.cause : undefined); finish(); }
          else if (!closed && !finished) {
            const stopped = await Promise.race([exitState.promise.then(() => ({ type: 'exited' as const })), deadline]);
            if (stopped.type === 'deadline') { failTermination('scope-completion-deadline'); finish(); }
          }
          return;
        }
        const observed = await Promise.race([identityState.promise.then(value => ({ type: 'identity' as const, value })), deadline]);
        if (observed.type === 'deadline') { controller.abort(); failTermination('identity-wait-deadline'); finish(); return; }
        if (observed.value === null || exited || finished) return;
        const capturedIdentity = observed.value;
        const operation = Promise.resolve().then(() => options.processControl.terminateProcessTree({ process: capturedIdentity, policy: options.terminationPolicy, signal: controller.signal }))
          .then(() => ({ type: 'terminated' as const }), (cause: unknown) => ({ type: 'failed' as const, cause }));
        const outcome = await Promise.race([operation, deadline]);
        if (outcome.type === 'deadline') { controller.abort(); failTermination('provider-deadline'); finish(); return; }
        if (outcome.type === 'failed') { controller.abort(); failTermination('provider', outcome.cause); }
        if (!exited) {
          const stopped = await Promise.race([exitState.promise.then(() => ({ type: 'exited' as const })), deadline]);
          if (stopped.type === 'deadline') { controller.abort(); failTermination('exit-deadline'); finish(); }
        }
      } finally {
        controller.abort();
        operationScope.clear();
        operationScopes.delete(operationScope);
        terminationPending = false;
        if (closed && !finished) finish();
      }
    })().then(() => completion.resolve(undefined), (cause: unknown) => {
      failTermination('lifecycle', cause);
      finish();
      completion.resolve(undefined);
    });
    return termination;
  };
  const output = (stream: 'stdout' | 'stderr', chunk: Uint8Array) => {
    if (finished || spec.output?.mode === 'ignore') return;
    const capture = stream === 'stdout' ? stdout : stderr;
    capture?.append(chunk);
    emit({ type: stream, chunk: Uint8Array.from(chunk) });
    if (spec.output?.mode === 'capture' && spec.output.overflow === 'fail' && capture?.truncated === true) {
      reason ??= 'output-overflow';
      diagnose('COMMAND_OUTPUT_OVERFLOW', { stream, maxBytesPerStream: spec.output.maxBytesPerStream });
      void requestTermination('output-overflow');
    }
  };
  const onStdout = (chunk: Uint8Array) => output('stdout', chunk);
  const onStderr = (chunk: Uint8Array) => output('stderr', chunk);
  const onExit = (code: number | null, signal: string | null) => {
    const firstExit = !exited;
    exited = true;
    exitCode = code;
    exitSignal = signal;
    scope.clear();
    identityController.abort();
    exitState.resolve(undefined);
    if (firstExit && !closed) closingScope.timeout(() => {
      reason = 'termination-failure';
      diagnose('COMMAND_TERMINATION_FAILED', { stage: 'stream-close-deadline' });
      finish();
    }, options.terminationTimeoutMs);
  };
  const onClose = (code: number | null, signal: string | null) => {
    closed = true;
    onExit(code, signal);
    identityState.resolve(identity);
    if (!terminationPending) finish();
  };
  const onError = (cause: Error) => {
    if (finished) return;
    if (startedAt !== undefined) {
      reason = 'termination-failure';
      diagnose('COMMAND_TERMINATION_FAILED', { stage: 'child-process-error' }, cause);
      directCleanup();
      finish();
      return;
    }
    diagnose('COMMAND_START_FAILED', {}, cause);
    reason = 'start-failure';
    pidState.reject(new CommandRunnerError('COMMAND_START_FAILED', {}, cause));
    identityState.resolve(identity);
    directCleanup();
    finish();
  };
  const authorizeStart = (): Promise<void> => {
    if (finished || exited || reason !== undefined) return Promise.reject(new CommandRunnerError('COMMAND_SCOPE_FAILED', { reason: 'INACTIVE' }));
    authorization ??= (async () => {
      await ready.promise;
      if (!owned || finished || exited || reason !== undefined || spec.signal?.aborted) throw new CommandRunnerError('COMMAND_SCOPE_FAILED', { reason: 'INACTIVE' });
      try { await owned.authorize(identityController.signal); }
      catch (cause) { diagnose('COMMAND_SCOPE_FAILED', { stage: 'authorize' }, cause); await requestTermination('abort'); throw new CommandRunnerError('COMMAND_SCOPE_FAILED', { stage: 'authorize' }, cause); }
    })();
    void authorization.catch(() => {}); return authorization;
  };
  const onSpawn = (ownedPid?: number) => {
    if (finished) return;
    const pid = ownedPid ?? child?.pid;
    if (pid === undefined) { onError(new CommandRunnerError('COMMAND_START_FAILED')); return; }
    startedAt ??= now();
    pidState.resolve(pid);
    emit({ type: 'spawned', pid });
    if (!spec.ownedScope && spec.timeoutMs !== undefined) scope.timeout(() => { void requestTermination('timeout'); }, spec.timeoutMs);
    if (spec.heartbeatMs !== undefined) scope.interval(() => {
      if (!exited && !finished) emit({ type: 'heartbeat', elapsedMs: Math.max(0, now() - (startedAt ?? now())) });
    }, spec.heartbeatMs);
    void acquireProcessIdentity(pid, identityController.signal, options).then(async observed => {
      if (finished || exited || observed.type === 'exited') { identityState.resolve(null); return; }
      if (observed.type === 'identified') {
        if (owned) {
          try { await owned.bind(observed.identity, identityController.signal); }
          catch (cause) { diagnose('COMMAND_SCOPE_FAILED', { stage: 'bind' }, cause); identityState.resolve(null); ready.reject(cause); await requestTermination('abort'); return; }
          if (finished || reason !== undefined) { identityState.resolve(null); return; }
        }
        identity = observed.identity;
        identityState.resolve(identity);
        emit({ type: 'identified', identity });
        if (owned && spec.ownedScope) {
          ready.resolve(undefined);
          emit({ type: 'scope-ready', identity, scopeId: owned.scopeId, binding: spec.ownedScope.binding });
          if (spec.ownedScope.start === 'automatic' && reason === undefined && !finished) void authorizeStart().catch(() => {});
        }
      } else {
        reason = 'start-failure';
        diagnose('COMMAND_IDENTITY_UNAVAILABLE', { pid }, observed.cause);
        identityState.resolve(null);
        if (owned) { ready.reject(new CommandRunnerError('COMMAND_IDENTITY_UNAVAILABLE')); await requestTermination('abort'); }
        else { directCleanup(); if (!finished) scope.timeout(finish, options.terminationTimeoutMs); }
      }
    }).catch(cause => { diagnose('COMMAND_SCOPE_FAILED', { stage: 'identity' }, cause); void requestTermination('abort'); });
  };
  const running: RunningCommand = {
    pid: pidState.promise, identity: identityState.promise, result: resultState.promise,
    terminate: (requested = 'abort') => requestTermination(requested),
    ...(spec.ownedScope?.start === 'manual' ? { authorizeStart } : {}),
  };
  if (spec.signal?.aborted === true) {
    reason = 'abort';
    diagnose('COMMAND_ABORTED_BEFORE_START');
    pidState.reject(new CommandRunnerError('COMMAND_ABORTED_BEFORE_START'));
    finish();
    return running;
  }
  spec.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (spec.ownedScope) {
      startedAt = now();
      if (spec.timeoutMs !== undefined) scope.timeout(() => { void requestTermination('timeout'); }, spec.timeoutMs);
      owned = startOwnedAdapter(options, spec, {
        output, spawned: onSpawn,
        failed: cause => {
          if (finished) return;
          pidState.reject(new CommandRunnerError('COMMAND_SCOPE_FAILED', {}, cause));
          identityState.resolve(null); ready.reject(cause); diagnose('COMMAND_SCOPE_FAILED', { stage: 'provider' }, cause);
          reason = 'termination-failure';
          if (owned) void requestTermination('abort');
        },
        completed: result => {
          if (finished) return;
          ownedClosure = result.closure;
          if (result.closure.status !== 'closed' || result.closure.scopeId !== owned?.scopeId || result.closure.binding !== spec.ownedScope?.binding
            || result.closure.rootIdentity.pid !== identity?.pid || result.closure.rootIdentity.startToken !== identity.startToken) {
            reason = 'termination-failure'; diagnose('COMMAND_SCOPE_UNKNOWN');
          }
          onClose(result.exitCode, result.signal);
        },
      });
      return running;
    }
    child = spawn(spec.command, [...(spec.args ?? [])], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: createEnvironment(spec.environment ?? { mode: 'inherit' }, options.platform),
      shell: false, windowsHide: true, detached: options.platform === 'posix',
      stdio: ['ignore', spec.output?.mode === 'ignore' ? 'ignore' : 'pipe', spec.output?.mode === 'ignore' ? 'ignore' : 'pipe'],
    });
    child.on('spawn', onSpawn);
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
  } catch (cause) {
    onError(cause instanceof Error ? cause : new CommandRunnerError('COMMAND_START_FAILED', {}, cause));
  }
  return running;
}
