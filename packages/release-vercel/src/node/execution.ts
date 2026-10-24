import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, resolve, win32 } from 'node:path';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { createPosixProcessControl, createPosixProcessIdentityReader, createWindowsProcessControl, createWindowsProcessIdentityReader } from '@openge/forge-process-control-node';
import type { ReleaseCheck, ReleaseConfig, ReleaseErrorCode, ReleaseStep } from '../contracts.js';
import { assertActive, redact, ReleaseError } from './errors.js';
import { LiveOutput } from './live-output.js';
import type { ExecutionLifecycle } from './release-context.js';
import { managedOwnedScopeProvider } from './owned-command-runner.js';

// 自动维护也属于本次 Git 命令；通过单次配置保持前台，不修改宿主或仓库设置。
const foregroundGitArguments = ['-c', 'maintenance.autoDetach=false', '-c', 'gc.autoDetach=false'];

export function resolveInvocation(command: string, args: readonly string[]): { command: string; args: readonly string[] } {
  if (command === 'node') return { command: process.execPath, args };
  if (process.platform !== 'win32' || !['pnpm', 'npm'].includes(command)) return { command, args };
  if (command === 'pnpm' && process.env.npm_execpath?.endsWith('pnpm.cjs') && existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (command === 'npm') {
      const path = resolve(directory, 'node_modules/npm/bin/npm-cli.js');
      if (existsSync(path)) return { command: process.execPath, args: [path, ...args] };
    } else {
      const shim = resolve(directory, 'pnpm.cmd');
      if (!existsSync(shim)) continue;
      const match = /%~dp0([^"\r\n]*?pnpm\.cjs)/iu.exec(readFileSync(shim, 'utf8'));
      const path = match?.[1] === undefined ? undefined : win32.join(dirname(shim), match[1]);
      if (path && existsSync(path)) return { command: process.execPath, args: [path, ...args] };
    }
  }
  throw new ReleaseError('COMMAND_FAILED', { executable: command, reason: 'JS_CLI_UNAVAILABLE' });
}
export function vercelInvocation(args: readonly string[]): { command: string; args: readonly string[] } {
  const require = createRequire(import.meta.url);
  return { command: process.execPath, args: [resolve(dirname(require.resolve('vercel/package.json')), 'dist/vc.js'), ...args] };
}
export class Execution {
  private readonly runner: ReturnType<typeof createNodeCommandRunner>;
  constructor(readonly cwd: string, readonly config: Pick<ReleaseConfig, 'limits'>, readonly signal: AbortSignal | undefined,
    readonly steps: ReleaseStep[], private readonly lifecycle?: ExecutionLifecycle) {
    const control = process.platform === 'win32' ? createWindowsProcessControl({ listenerBackend: 'netstat' }) : createPosixProcessControl({ listenerBackend: 'lsof' });
    const reader = process.platform === 'win32' ? createWindowsProcessIdentityReader() : createPosixProcessIdentityReader();
    this.runner = createNodeCommandRunner({ platform: process.platform === 'win32' ? 'win32' : 'posix',
      ...(lifecycle ? { ownedScopeProvider: managedOwnedScopeProvider() } : {}),
      processControl: { ...control, listProcesses: async request => {
        const pid = request?.pids?.length === 1 ? request.pids[0] : undefined;
        if (pid !== undefined) {
          const observed = await reader.readIdentity({ pid, ...(request?.signal ? { signal: request.signal } : {}) });
          return observed.status === 'FOUND' ? [observed.identity] : [];
        }
        return control.listProcesses(request);
      } },
      terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 5000,
      // 管理检查同样需要宿主身份观测；统一启动预算，但不得超过原有总命令时限。
      identityAcquisition: { timeoutMs: Math.min(10_000, config.limits.commandMs), pollIntervalMs: 20 } });
  }
  async run(name: string, check: ReleaseCheck, errorCode: ReleaseErrorCode, values?: Readonly<Record<string, string>>,
    signal = this.signal, captureStep = true, onOutput?: (text: string) => void): Promise<string> {
    assertActive(signal);
    const invocation = resolveInvocation(check.command, check.args ?? []);
    const live = onOutput === undefined ? undefined : new LiveOutput(this.config.limits.maxOutputBytes, onOutput);
    const execute = this.lifecycle ? this.lifecycle.execute.bind(this.lifecycle, this.runner, name) : this.runner.run.bind(this.runner);
    const result = await execute({ ...invocation, cwd: this.cwd,
      environment: { mode: 'inherit', values: { GIT_TERMINAL_PROMPT: '0', VERCEL_TELEMETRY_DISABLED: '1', ...values } },
      output: { mode: 'capture', maxBytesPerStream: this.config.limits.maxOutputBytes, overflow: 'truncate' },
      timeoutMs: Math.min(check.timeoutMs ?? this.config.limits.commandMs, this.config.limits.commandMs),
      ...(signal === undefined ? {} : { signal }),
    }, live === undefined ? undefined : event => {
      if (event.type === 'stdout' || event.type === 'stderr') live.write(event.type, event.chunk);
    });
    live?.finish();
    const stdout = redact(new TextDecoder().decode(result.stdout));
    const stderr = redact(new TextDecoder().decode(result.stderr));
    const ok = result.exitCode === 0 && result.terminationReason === 'exit';
    if (captureStep) this.steps.push({ name, ok, durationMs: result.durationMs,
      stdout, stderr, exitCode: result.exitCode, truncated: !!result.stdoutTruncated || !!result.stderrTruncated });
    assertActive(signal);
    if (result.terminationReason === 'timeout') throw new ReleaseError('COMMAND_TIMEOUT', { step: name });
    if (!ok) {
      if (errorCode === 'VERCEL_API' && /(?:no existing credentials|not authenticated|log ?in|unauthorized|invalid token|authentication)/iu.test(stdout + stderr)) {
        throw new ReleaseError('AUTH_REQUIRED');
      }
      throw new ReleaseError(errorCode, { step: name, exitCode: result.exitCode, termination: result.terminationReason,
        ...(errorCode === 'GIT_FAILED' ? { stdout, stderr, truncated: !!result.stdoutTruncated || !!result.stderrTruncated } : {}) });
    }
    if (!captureStep && (result.stdoutTruncated || result.stderrTruncated)) throw new ReleaseError(errorCode, { reason: 'OUTPUT_LIMIT', step: name });
    return stdout.trim();
  }
  git(args: readonly string[]): Promise<string> {
    return this.run('git', { command: 'git', args: [...foregroundGitArguments, ...args] }, 'GIT_FAILED', undefined, this.signal, false);
  }
  async streamGit(args: readonly string[], onChunk: (chunk: Uint8Array) => void, allowedExitCodes: readonly number[] = [0]): Promise<void> {
    assertActive(this.signal);
    const controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    let failure: unknown;
    const execute = this.lifecycle ? this.lifecycle.execute.bind(this.lifecycle, this.runner, 'git-stream') : this.runner.run.bind(this.runner);
    const result = await execute({ command: 'git', args: [...foregroundGitArguments, ...args], cwd: this.cwd,
      environment: { mode: 'inherit', values: { GIT_TERMINAL_PROMPT: '0' } }, output: { mode: 'events' },
      timeoutMs: this.config.limits.commandMs, signal }, event => {
      if (event.type === 'stdout' && failure === undefined) {
        try { onChunk(event.chunk); } catch (error) { failure = error; controller.abort(); }
      }
    });
    if (failure !== undefined) throw failure;
    assertActive(this.signal);
    if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode) || result.terminationReason !== 'exit') {
      throw new ReleaseError('GIT_FAILED', { reason: 'STREAM_FAILED', exitCode: result.exitCode, termination: result.terminationReason });
    }
  }
}
