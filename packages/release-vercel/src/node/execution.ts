import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, resolve, win32 } from 'node:path';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { createPosixProcessControl, createWindowsProcessControl } from '@openge/forge-process-control-node';
import type { ReleaseCheck, ReleaseConfig, ReleaseErrorCode, ReleaseStep } from '../contracts.js';
import { assertActive, redact, ReleaseError } from './errors.js';
import { LiveOutput } from './live-output.js';

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
  private readonly runner = createNodeCommandRunner({
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    processControl: process.platform === 'win32' ? createWindowsProcessControl({ listenerBackend: 'netstat' })
      : createPosixProcessControl({ listenerBackend: 'lsof' }),
    terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 5000,
    identityAcquisition: { timeoutMs: 2000, pollIntervalMs: 20 },
  });
  constructor(readonly cwd: string, readonly config: Pick<ReleaseConfig, 'limits'>, readonly signal: AbortSignal | undefined,
    readonly steps: ReleaseStep[]) {}
  async run(name: string, check: ReleaseCheck, errorCode: ReleaseErrorCode, values?: Readonly<Record<string, string>>,
    signal = this.signal, captureStep = true, onOutput?: (text: string) => void): Promise<string> {
    assertActive(signal);
    const invocation = resolveInvocation(check.command, check.args ?? []);
    const live = onOutput === undefined ? undefined : new LiveOutput(this.config.limits.maxOutputBytes, onOutput);
    const result = await this.runner.run({ ...invocation, cwd: this.cwd,
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
    return this.run('git', { command: 'git', args }, 'GIT_FAILED', undefined, this.signal, false);
  }
}
