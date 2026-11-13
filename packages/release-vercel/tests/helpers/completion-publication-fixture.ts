import { resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { afterEach, vi } from 'vitest';
import { managedRuns } from './managed-runs.js';
import { completionFixture } from './completion-fixture.js';
import { completionDeadline } from './completion-deadline.js';

const boundary = vi.hoisted(() => ({ counter: '', deadline: undefined as ReturnType<typeof completionDeadline> | undefined,
  blockCompletionIdentity: false, completionRequested: undefined as (() => void) | undefined,
  phases: [] as { phase: string; at: number; utc: string }[],
  steps: [] as { name: string; durationMs: number; ok: boolean }[] }));
vi.mock('@openge/forge-command-runner/node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-command-runner/node')>();
  return { ...actual, createNodeCommandRunner: (options: Parameters<typeof actual.createNodeCommandRunner>[0]) => {
    const runner = actual.createNodeCommandRunner({ ...options, ...boundary.deadline?.timers });
    return { ...runner, start: (...args: Parameters<typeof runner.start>) => {
      if (args[0].args?.some(value => value.endsWith('completion-job.mjs'))) {
        const requested = boundary.completionRequested; boundary.completionRequested = undefined; requested?.();
      }
      const running = runner.start(...args);
      // 仅失败时保存有界分类，不输出命令参数、环境或凭据；真实执行和回执保持原样。
      void running.result.then(result => {
        if (result.terminationReason === 'exit') return;
        const cause = (value: unknown, depth = 0): Record<string, unknown> => {
          if (!value || typeof value !== 'object' || depth > 3) return {};
          const row = value as Record<string, unknown>;
          const details = row.details && typeof row.details === 'object' ? row.details as Record<string, unknown> : {};
          return { code: row.code, stage: details.stage, reason: details.reason,
            ...(row.cause ? { cause: cause(row.cause, depth + 1) } : {}) };
        };
        process.stderr.write(`COMPLETION_COMMAND_FAILURE ${JSON.stringify({ termination: result.terminationReason,
          durationMs: result.durationMs, exitCode: result.exitCode, closure: result.ownedScope,
          diagnostics: result.diagnostics.slice(0, 16).map(value => cause(value)) })}\n`);
      }, () => {});
      return running;
    } };
  } };
});
vi.mock('../../src/node/owned-command-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/node/owned-command-runner.js')>();
  return { ...actual, managedOwnedScopeProvider: () => {
    const provider = actual.managedOwnedScopeProvider();
    return { start: (request: Parameters<typeof provider.start>[0], observer: Parameters<typeof provider.start>[1]) => {
      const scope = provider.start(request, observer);
      if (!boundary.blockCompletionIdentity || !request.args?.some(value => value.endsWith('completion-job.mjs'))) return scope;
      // 宿主仍真实启动并清空；身份保持未知，授权与payload绝不能执行。
      return { ...scope, rootPid: scope.completion.then(() => { throw new Error('FIXTURE_COMPLETION_IDENTITY_DELAYED'); }) };
    } };
  } };
});
// 真实 CLI 子进程验证原 prebuilt argv；无真实云写入。
vi.mock('../../src/node/execution.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/node/execution.js')>();
  return { ...actual, vercelInvocation: (args: readonly string[]) => {
    if (args[0] !== '--global-config' || args[2] !== 'deploy') throw new Error('unexpected controlled CLI operation');
    return { command: process.execPath, args: [resolve(import.meta.dirname, 'prebuilt-cli.mjs'), boundary.counter, 'ok', ...args] };
  } };
});
const fixtures: Awaited<ReturnType<typeof completionFixture>>[] = [];
const runs = managedRuns(), runRelease = runs.run;
afterEach(async context => {
  // 超时后先保存取消/清理之前的现场；正常路径只在整例结束后输出内存时间线，不插入同步阶段日志。
  if (context.task.result?.state === 'fail' && boundary.phases.length) {
    const snapshots = await Promise.all(fixtures.map(async fixture => {
      try {
        const state = JSON.parse(await readFile(resolve(fixture.cwd, 'state/release-slot/state.json'), 'utf8'));
        const exists = async (path: string) => stat(path).then(() => true, (error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error;
        });
        return { utc: new Date().toISOString(), stage: state.stage, completion: state.completion?.status,
          lastCommands: state.processes.slice(-3).map((item: { name: string; status: string }) => ({ name: item.name, status: item.status })),
          observations: (await fixture.results()).length,
          control: await readFile(fixture.control, 'utf8'),
          lock: await exists(resolve(fixture.cwd, 'state/release-slot/run.lock')),
          receipt: await exists(resolve(fixture.cwd, 'state/release-slot/latest-publish.json')) };
      } catch (error) { return { snapshotError: error instanceof Error ? error.name : typeof error }; }
    }));
    process.stderr.write(`COMPLETION_TEST_FAILURE ${JSON.stringify({ phases: boundary.phases, steps: boundary.steps, snapshots })}\n`);
  }
  await runs.close();
  boundary.deadline?.dispose(); boundary.deadline = undefined; boundary.blockCompletionIdentity = false;
  boundary.completionRequested = undefined;
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  if (boundary.phases.length) process.stdout.write(`COMPLETION_TEST_TIMELINE ${JSON.stringify({ phases: boundary.phases, steps: boundary.steps })}\n`);
  boundary.phases = []; boundary.steps = [];
  boundary.counter = '';
});
async function fixture(options?: Parameters<typeof completionFixture>[0]) {
  const value = await completionFixture(options); fixtures.push(value); boundary.counter = value.createCounter; return value;
}

export { boundary, fixture, runRelease };
