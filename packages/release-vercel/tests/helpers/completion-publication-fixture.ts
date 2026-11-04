import { resolve } from 'node:path';
import { afterEach, vi } from 'vitest';
import { managedRuns } from './managed-runs.js';
import { completionFixture } from './completion-fixture.js';
import { completionDeadline } from './completion-deadline.js';

const boundary = vi.hoisted(() => ({ counter: '', deadline: undefined as ReturnType<typeof completionDeadline> | undefined,
  blockCompletionIdentity: false }));
vi.mock('@openge/forge-command-runner/node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-command-runner/node')>();
  return { ...actual, createNodeCommandRunner: (options: Parameters<typeof actual.createNodeCommandRunner>[0]) =>
    actual.createNodeCommandRunner({ ...options, ...boundary.deadline?.timers }) };
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
afterEach(async () => {
  await runs.close();
  boundary.deadline?.dispose(); boundary.deadline = undefined; boundary.blockCompletionIdentity = false;
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  boundary.counter = '';
});
async function fixture(options?: Parameters<typeof completionFixture>[0]) {
  const value = await completionFixture(options); fixtures.push(value); boundary.counter = value.createCounter; return value;
}

export { boundary, fixture, runRelease };
