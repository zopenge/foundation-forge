import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runRelease, validateReleaseConfig } from '../src/node.js';
import type { ReleaseConfig, ReleaseTransport } from '../src/index.js';

const roots: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, shell: false, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const fixture = async () => {
  const base = resolve(repositoryRoot, '.tmp/release-vercel-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'r-'));
  roots.push(root);
  const remote = resolve(root, 'remote.git');
  const cwd = resolve(root, 'work');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'dev', cwd);
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  git(cwd, 'config', 'user.name', 'Fixture');
  await writeFile(resolve(cwd, '.gitignore'), '.tmp/\n');
  await writeFile(resolve(cwd, 'source.txt'), 'initial\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  const declared = 'https://github.com/fixture/repository.git';
  git(cwd, 'config', `url.${remote.replaceAll('\\', '/')}.insteadOf`, declared);
  git(cwd, 'remote', 'add', 'origin', declared);
  git(cwd, 'push', 'origin', 'HEAD:dev', 'HEAD:main');
  const initial = git(cwd, 'rev-parse', 'HEAD');
  await writeFile(resolve(cwd, 'source.txt'), 'candidate\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'candidate');
  const sha = git(cwd, 'rev-parse', 'HEAD');
  const config: ReleaseConfig = {
    schemaVersion: 1,
    git: { remote: 'origin', repository: 'github.com/fixture/repository', developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [{ command: 'node', args: ['-e', 'process.stdout.write("checked")'], timeoutMs: 10_000 }],
    acceptance: [{ command: 'node', args: ['-e', 'if(!process.env.FORGE_RELEASE_SHA)process.exit(4)'], timeoutMs: 10_000 }],
    buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 10_000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 },
  };
  const deployment = { id: 'dpl_fixture', projectId: 'prj_fixture', target: 'production', readyState: 'READY',
    source: 'git', gitSource: { type: 'github', repoId: 101, org: 'fixture', repo: 'repository', sha, ref: 'main' }, meta: { githubCommitSha: sha, githubCommitRef: 'main' }, url: 'fixture.vercel.app' };
  const project = { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', deployHooks: [], gitCredentialId: 'fixture' } };
  let queries = 0;
  const transport: ReleaseTransport = {
    api: async (path) => { queries++; return path.startsWith('/v6/deployments') ? { deployments: [deployment] }
      : path.startsWith('/v13/deployments') ? deployment
        : path.startsWith('/v9/projects') ? project
        : { alias: 'fixture.example.invalid', deploymentId: deployment.id, projectId: deployment.projectId }; },
    buildInfo: async () => ({ revision: sha }),
  };
  const run = (command: 'check' | 'publish' | 'status' | 'verify' = 'publish', overrides = {}) =>
    runRelease({ command, cwd, config, transport, ...overrides });
  const ref = (branch: string) => git(root, '--git-dir', remote, 'rev-parse', branch);
  return { root, cwd, remote, sha, initial, config, deployment, project, transport, run, ref, queries: () => queries };
};

describe('strict configuration', () => {
  it('accepts only the explicit schema and finite limits', async () => {
    const f = await fixture();
    expect(validateReleaseConfig(f.config)).toEqual(f.config);
    for (const config of [ { ...f.config, unknown: true }, { ...f.config, limits: { ...f.config.limits, pollMs: 0 } },
      { ...f.config, git: { ...f.config.git, releaseBranch: 'dev' } },
      { ...f.config, vercel: { ...f.config.vercel, productionUrl: 'https://name:secret@example.invalid' } } ]) {
      expect(() => validateReleaseConfig(config)).toThrow('CONFIG_INVALID');
    }
  });
});

describe('real Git release gates', () => {
  it('checks without pushing or querying Vercel', async () => {
    const f = await fixture(); const report = await f.run('check');
    expect(report.ok).toBe(true); expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
    expect(f.queries()).toBe(0);
  });
  it.each(['dirty', 'branch', 'repository', 'diverged', 'check', 'candidate'])('stops before remote writes for %s failure', async (mode) => {
    const f = await fixture();
    const expected = { dirty: 'GIT_DIRTY', branch: 'GIT_BRANCH', repository: 'GIT_REPOSITORY', diverged: 'GIT_DIVERGED', check: 'CHECK_FAILED', candidate: 'CANDIDATE_CHANGED' }[mode];
    if (mode === 'dirty') await writeFile(resolve(f.cwd, 'untracked.txt'), 'dirty');
    if (mode === 'branch') git(f.cwd, 'checkout', '-b', 'other');
    if (mode === 'repository') Object.assign(f.config.git, { repository: 'github.com/wrong/repo' });
    if (mode === 'diverged') {
      git(f.cwd, 'checkout', '-b', 'fork', f.initial);
      await writeFile(resolve(f.cwd, 'fork.txt'), 'fork'); git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-m', 'fork');
      git(f.cwd, 'push', 'origin', 'HEAD:main'); git(f.cwd, 'checkout', 'dev');
    }
    if (mode === 'check') Object.assign(f.config, { checks: [{ command: 'node', args: ['-e', 'process.exit(3)'] }] });
    if (mode === 'candidate') Object.assign(f.config, { checks: [{ command: 'node', args: ['-e', 'require("node:fs").writeFileSync("source.txt","changed")'] }] });
    const before = f.ref('main'); const report = await f.run();
    expect(report.ok).toBe(false); expect(report.error?.code).toBe(expected);
    expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(before);
    await expect(readFile(resolve(f.cwd, '.tmp/forge-vercel-release/publish.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes the fixed SHA and resumes idempotently without another remote update', async () => {
    const f = await fixture();
    const first = await f.run(); expect(first.ok).toBe(true); expect(first.candidateSha).toBe(f.sha);
    expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.sha);
    const hooks = resolve(f.remote, 'hooks/pre-receive');
    await writeFile(hooks, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const second = await f.run(); expect(second.ok).toBe(true);
    expect(second.effects.developmentPush).toBe('already-current'); expect(second.effects.releasePush).toBe('already-current');
  });
  it.each(['project', 'sha', 'failed', 'timeout', 'alias', 'revision', 'acceptance'])('reports partial Git success on %s verification failure', async (mode) => {
    const f = await fixture();
    const expected = { project: 'DEPLOYMENT_SOURCE', sha: 'DEPLOYMENT_TIMEOUT', failed: 'DEPLOYMENT_FAILED', timeout: 'DEPLOYMENT_TIMEOUT', alias: 'ALIAS_MISMATCH', revision: 'BUILD_REVISION', acceptance: 'ACCEPTANCE_FAILED' }[mode];
    if (mode === 'project') f.deployment.projectId = 'prj_wrong';
    if (mode === 'sha') { f.deployment.gitSource.sha = f.initial; f.deployment.meta.githubCommitSha = f.initial; }
    if (mode === 'failed') f.deployment.readyState = 'ERROR';
    if (mode === 'timeout') f.deployment.readyState = 'BUILDING';
    const transport: ReleaseTransport = { ...f.transport,
      ...(mode === 'alias' ? { api: async (path: string, signal: AbortSignal) => path.startsWith('/v4/aliases') ? { projectId: 'prj_fixture', deploymentId: 'dpl_other' } : f.transport.api(path, signal) } : {}),
      ...(mode === 'revision' ? { buildInfo: async () => ({ revision: f.initial }) } : {}),
    };
    if (mode === 'acceptance') Object.assign(f.config, { acceptance: [{ command: 'node', args: ['-e', 'process.exit(5)'] }] });
    const report = await f.run('publish', { transport });
    expect(report.ok).toBe(false); expect(report.error?.code).toBe(expected);
    expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.sha); expect(report.effects.releasePush).toBe('pushed');
    expect(report.recovery?.candidateSha).toBe(f.sha);
  });
  it('status reads the explicit SHA and verify performs independent acceptance', async () => {
    const f = await fixture();
    const status = await f.run('status', { sha: f.sha }); expect(status.ok).toBe(true); expect(status.deployment?.id).toBe('dpl_fixture');
    const verify = await f.run('verify', { sha: f.sha }); expect(verify.ok).toBe(true);
    expect(f.ref('main')).toBe(f.initial);
  });
  it('uses the saved publish SHA after later development commits', async () => {
    const f = await fixture(); expect((await f.run()).ok).toBe(true);
    await writeFile(resolve(f.cwd, 'later.txt'), 'later'); git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-m', 'later');
    expect((await f.run('status')).candidateSha).toBe(f.sha);
    expect((await f.run('verify')).candidateSha).toBe(f.sha);
  });
  it('records a rejected main push after the development push without rolling back', async () => {
    const f = await fixture();
    await writeFile(resolve(f.remote, 'hooks/update'), '#!/bin/sh\nif [ "$1" = "refs/heads/main" ]; then exit 1; fi\n', { mode: 0o755 });
    const report = await f.run();
    expect(report.error?.code).toBe('GIT_FAILED'); expect(report.effects.developmentPush).toBe('pushed');
    expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.initial);
    expect(report.recovery?.nextCommand).toBe('forge-vercel-release publish');
    expect((await f.run('status')).candidateSha).toBe(f.sha);
  });
  it('rejects a mismatched project before the first remote push', async () => {
    const f = await fixture();
    const transport: ReleaseTransport = { ...f.transport, api: async (path, signal) => path.startsWith('/v9/projects')
      ? { id: 'prj_wrong' } : f.transport.api(path, signal) };
    const report = await f.run('publish', { transport });
    expect(report.error?.code).toBe('DEPLOYMENT_SOURCE'); expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  });
  it('preserves a replaced lock owned by another publisher', async () => {
    const f = await fixture();
    const transport: ReleaseTransport = { ...f.transport, buildInfo: async () => {
      await writeFile(resolve(f.cwd, '.tmp/forge-vercel-release/publish.lock'), '{"token":"other"}');
      return { revision: f.sha };
    } };
    const report = await f.run('publish', { transport });
    expect(report.error?.code).toBe('LOCK_OWNERSHIP');
    expect(await readFile(resolve(f.cwd, '.tmp/forge-vercel-release/publish.lock'), 'utf8')).toBe('{"token":"other"}');
  });
  it('does not push either branch when a check replaces the lock', async () => {
    const f = await fixture();
    Object.assign(f.config, { checks: [{ command: 'node', args: ['-e', 'require("node:fs").writeFileSync(".tmp/forge-vercel-release/publish.lock","other")'] }] });
    const report = await f.run();
    expect(report.error?.code).toBe('LOCK_OWNERSHIP'); expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  });
  it('does not push main when the development push replaces the lock', async () => {
    const f = await fixture();
    const path = resolve(f.cwd, '.tmp/forge-vercel-release/publish.lock').replaceAll('\\', '/');
    await writeFile(resolve(f.remote, 'hooks/update'), `#!/bin/sh\nif [ "$1" = "refs/heads/dev" ]; then printf other > "${path}"; fi\n`, { mode: 0o755 });
    const report = await f.run();
    expect(report.error?.code).toBe('LOCK_OWNERSHIP'); expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.initial);
  });
  it('lets the Git server reject a remote advance after the final refs snapshot', async () => {
    const f = await fixture();
    git(f.cwd, 'push', 'origin', `${f.sha}:refs/heads/main`);
    git(f.cwd, 'checkout', '-b', 'future');
    await writeFile(resolve(f.cwd, 'future.txt'), 'future'); git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-m', 'future');
    const future = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'push', 'origin', `${future}:refs/heads/future`); git(f.cwd, 'checkout', 'dev');
    let projectReads = 0;
    const transport: ReleaseTransport = { ...f.transport, api: async (path, signal) => {
      if (path.startsWith('/v9/projects') && ++projectReads === 2) git(f.root, '--git-dir', f.remote, 'update-ref', 'refs/heads/main', future, f.sha);
      return f.transport.api(path, signal);
    } };
    const report = await f.run('publish', { transport });
    expect(report.error?.code).toBe('GIT_FAILED'); expect(report.effects.developmentPush).toBe('pushed');
    expect(f.ref('main')).toBe(future);
  });
  it.each(['repository', 'production-branch', 'source-repo', 'source-branch'])('rejects bound %s mismatch with actual Git effects', async mode => {
    const f = await fixture();
    if (mode === 'repository') f.project.link.repo = 'wrong';
    if (mode === 'production-branch') f.project.link.productionBranch = 'dev';
    if (mode === 'source-repo') f.deployment.gitSource.repoId = 999;
    if (mode === 'source-branch') f.deployment.gitSource.ref = 'dev';
    const report = await f.run(); expect(report.error?.code).toBe('DEPLOYMENT_SOURCE');
    const expected = mode.startsWith('source-') ? f.sha : f.initial;
    expect(f.ref('dev')).toBe(expected); expect(f.ref('main')).toBe(expected);
  });
  it('holds one lock and releases it after cancellation', async () => {
    const f = await fixture(); let entered!: () => void;
    const ready = new Promise<void>((resolveReady) => { entered = resolveReady; });
    const controller = new AbortController();
    const transport: ReleaseTransport = { ...f.transport, api: async (_path, signal) => {
      entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } };
    const running = f.run('publish', { transport, signal: controller.signal }); await ready;
    const concurrent = await f.run(); expect(concurrent.error?.code).toBe('LOCKED');
    controller.abort(); const report = await running; expect(report.error?.code).toBe('CANCELLED');
    expect((await f.run()).ok).toBe(true);
  });
  it('bounds and redacts actual process output, with finite timeout', async () => {
    const f = await fixture();
    Object.assign(f.config, { checks: [{ command: 'node', args: ['-e', 'console.log("token=SECRET "+"x".repeat(9000));process.exit(2)'] }] });
    const report = await f.run('check'); const serialized = JSON.stringify(report);
    expect(report.error?.code).toBe('CHECK_FAILED'); expect(serialized).not.toContain('SECRET'); expect(serialized.length).toBeLessThan(12_000);
    Object.assign(f.config, { checks: [{ command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 }] });
    expect((await f.run('check')).error?.code).toBe('COMMAND_TIMEOUT');
    const abort = new AbortController(); abort.abort();
    expect((await f.run('check', { signal: abort.signal })).error?.code).toBe('CANCELLED');
  });
});
