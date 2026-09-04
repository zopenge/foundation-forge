import { spawn, type ChildProcess } from 'node:child_process';
import type { ProcessIdentity } from '@openge/forge-process-control';
import type { CommandDiagnostic, CommandErrorCode, CommandEvent, CommandObserver, CommandResult, CommandSpec, CommandTerminationReason, RunningCommand } from '../contracts.js';
import { CommandRunnerError } from '../errors.js';
import { normalizeCommandSpec } from '../normalize-spec.js';
import { CaptureBuffer } from './capture-buffer.js';
import { createEnvironment } from './environment.js';
import type { NodeCommandRunnerOptions } from './options.js';
import { acquireProcessIdentity } from './process-identity.js';
import { TimerScope } from './timers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

type RequestedReason = 'abort' | 'timeout' | 'output-overflow';

export function startCommand(options: NodeCommandRunnerOptions, input: CommandSpec, observer?: CommandObserver): RunningCommand {
  const spec = normalizeCommandSpec(input);
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
    if (!diagnostics.some(value => value.code === code)) diagnostics.push(Object.freeze({ code, details, ...(cause === undefined ? {} : { cause }) }));
  };
  const emit = (event: CommandEvent) => {
    try { observer?.(event); } catch (cause) { diagnose('COMMAND_OBSERVER_FAILED', { eventType: event.type }, cause); }
  };
  const onAbort = () => { void requestTermination('abort'); };
  const finish = () => {
    if (finished) return;
    finished = true;
    scope.clear();
    closingScope.clear();
    for (const operation of operationScopes) operation.clear();
    spec.signal?.removeEventListener('abort', onAbort);
    identityController.abort();
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
    });
    emit({ type: 'exited', result });
    Object.freeze(diagnostics);
    resultState.resolve(result);
  };
  const directCleanup = () => {
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
    if (finished || exited) return Promise.resolve();
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
  const onSpawn = () => {
    const pid = child?.pid;
    if (pid === undefined) { onError(new CommandRunnerError('COMMAND_START_FAILED')); return; }
    startedAt = now();
    pidState.resolve(pid);
    emit({ type: 'spawned', pid });
    if (spec.timeoutMs !== undefined) scope.timeout(() => { void requestTermination('timeout'); }, spec.timeoutMs);
    if (spec.heartbeatMs !== undefined) scope.interval(() => {
      if (!exited && !finished) emit({ type: 'heartbeat', elapsedMs: Math.max(0, now() - (startedAt ?? now())) });
    }, spec.heartbeatMs);
    void acquireProcessIdentity(pid, identityController.signal, options).then(observed => {
      if (finished || exited || observed.type === 'exited') { identityState.resolve(null); return; }
      if (observed.type === 'identified') {
        identity = observed.identity;
        identityState.resolve(identity);
        emit({ type: 'identified', identity });
      } else {
        reason = 'start-failure';
        diagnose('COMMAND_IDENTITY_UNAVAILABLE', { pid }, observed.cause);
        identityState.resolve(null);
        directCleanup();
        if (!finished) scope.timeout(finish, options.terminationTimeoutMs);
      }
    });
  };
  const running: RunningCommand = {
    pid: pidState.promise, identity: identityState.promise, result: resultState.promise,
    terminate: (requested = 'abort') => requestTermination(requested),
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
