import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managedFixture, git } from './helpers/managed-fixture.js';
import { gitRoutingParameters } from './helpers/git-routing.js';
import { Execution } from '../src/node/execution.js';
import { ReleaseError } from '../src/node/errors.js';
import { managedRuns } from './helpers/managed-runs.js';
import type { ReleaseTransport } from '../src/contracts.js';
import { commandComponentSession, publicationComponentSession } from './helpers/component-session.js';

// 聚焦真实推送丢响应与恢复决策；只读元数据查询不重复完整受管日志链路。
// push/fetch/检查命令仍真实受管，完整安装/发布接入在 managed-release 保留。
vi.mock('../src/node/managed-process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-process.js')>();
  return { ...actual, createManagedSession: async (...args: Parameters<typeof actual.createManagedSession>) =>
    publicationComponentSession(await actual.createManagedSession(...args)) };
});
vi.mock('../src/node/managed-checkout.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-checkout.js')>();
  return { ...actual,
    prepareCheckout: (session: Parameters<typeof actual.prepareCheckout>[0]) => actual.prepareCheckout(commandComponentSession(session)),
    prepareEnvironment: (session: Parameters<typeof actual.prepareEnvironment>[0]) => actual.prepareEnvironment(commandComponentSession(session)) };
});

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const runs = managedRuns();
afterEach(async () => { await runs.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) await f.dispose(); });
it('observes an accepted push with a lost response and never pushes that old intent again', { timeout: 720_000 }, async () => {
  const f = await managedFixture(); fixtures.push(f);
  const declared = 'https://github.com/fixture/repository.git';
  vi.stubEnv('GIT_CONFIG_PARAMETERS', gitRoutingParameters(f.root, f.remote, declared)); git(f.cwd, 'remote', 'set-url', 'origin', declared);
  Object.assign(f.config.git, { repository: 'github.com/fixture/repository' });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); const sha = f.commit();
  const deployment = { id: 'dpl_fixture', projectId: 'prj_fixture', target: 'production', readyState: 'READY', source: 'git',
    gitSource: { type: 'github', repoId: 101, org: 'fixture', repo: 'repository', sha, ref: 'main' }, url: 'fixture.vercel.app' };
  const transport: ReleaseTransport = { api: async path => {
    if (path.startsWith('/v9/projects')) return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
    if (path.startsWith('/v6/deployments')) return { deployments: [deployment] };
    if (path.startsWith('/v13/deployments')) return deployment;
    if (path.startsWith('/v4/aliases')) return { alias: 'fixture.example.invalid', deploymentId: deployment.id, projectId: deployment.projectId };
    throw new Error('unexpected API or deployment creation');
  }, buildInfo: async () => ({ revision: sha }) };
  const original = Execution.prototype.git, pushes: string[] = []; let lost = false;
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
    const output = await original.call(this, args);
    if (args[0] === 'push') {
      const target = args.at(-1) ?? ''; pushes.push(target);
      if (!lost && target.endsWith(':refs/heads/dev')) { lost = true; throw new ReleaseError('GIT_FAILED', { reason: 'FIXTURE_RESPONSE_LOST' }); }
    }
    return output;
  });
  const first = await runs.run({ cwd: f.cwd, command: 'publish', transport });
  expect(first).toMatchObject({ ok: false, effects: { developmentPush: 'unknown', releasePush: 'not-attempted' }, processes: { status: 'closed' } });
  expect(f.ref('dev')).toBe(sha); expect(f.ref('main')).toBe(f.initial);
  const next = await runs.run({ cwd: f.cwd, command: 'publish', transport });
  expect(next, JSON.stringify(next.error)).toMatchObject({ ok: true, effects: { developmentPush: 'already-current', releasePush: 'pushed' } });
  expect(pushes.filter(target => target.endsWith(':refs/heads/dev'))).toEqual([`${sha}:refs/heads/dev`]);
  expect(pushes.filter(target => target.endsWith(':refs/heads/main'))).toEqual([`${sha}:refs/heads/main`]);
  const history = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/history', `${first.runId}.json`), 'utf8'));
  expect(JSON.parse(history.snapshot.publish).report).toMatchObject({ ok: false, effects: { developmentPush: 'unknown' } });
  const prior = JSON.parse(history.snapshot.state);
  expect(prior.pendingPush).toBe('developmentPush');
  expect(prior.processes.some((command: { name: string; terminalSha256?: string; closure?: { ownedScope?: { status?: string; empty?: boolean } } }) =>
    command.name === 'git' && command.terminalSha256 && command.closure?.ownedScope?.status === 'closed' && command.closure.ownedScope.empty === true)).toBe(true);
});
