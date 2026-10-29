import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRelease, validateReleaseConfig } from '../src/node.js';
import type { ReleaseConfig, ReleaseTransport } from '../src/index.js';
import { prepareManagedFixtureHistory } from './helpers/managed-fixture-git.js';

const commandFailures = vi.hoisted((): { termination: string; identified: boolean; exitCode: number | null;
  durationMs: number; diagnostics: { code: string; stage?: string }[] }[] => []);
// 真实命令保持原样执行；只在失败断言中输出稳定分类，不记录 argv、环境或原始 cause。
vi.mock('@openge/forge-command-runner/node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-command-runner/node')>();
  return { ...actual, createNodeCommandRunner: (...args: Parameters<typeof actual.createNodeCommandRunner>) => {
    const runner = actual.createNodeCommandRunner(...args);
    return { ...runner, run: async (...parameters: Parameters<typeof runner.run>) => {
      const result = await runner.run(...parameters);
      if (result.terminationReason !== 'exit') commandFailures.push({ termination: result.terminationReason,
        identified: result.identity !== null, exitCode: result.exitCode, durationMs: result.durationMs,
        diagnostics: result.diagnostics.map(({ code, details }) => ({ code,
          ...(typeof details.stage === 'string' ? { stage: details.stage } : {}) })) });
      return result;
    } };
  } };
});
beforeEach(() => { commandFailures.length = 0; });

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
  await mkdir(cwd);
  await writeFile(resolve(cwd, '.gitignore'), '.tmp/\n');
  await writeFile(resolve(cwd, 'source.txt'), 'initial\n');
  const { initial, sha } = await prepareManagedFixtureHistory(root, cwd, remote);
  const declared = 'https://github.com/fixture/repository.git';
  git(cwd, 'config', `url.${remote.replaceAll('\\', '/')}.insteadOf`, declared);
  git(cwd, 'remote', 'set-url', 'origin', declared);
  const config: ReleaseConfig = {
    schemaVersion: 2, source: { mode: 'workspace' },
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
  it('rejects recovery in workspace mode before any Git or platform mutation', async () => {
    const f = await fixture();
    const report = await runRelease({ command: 'recover', cwd: f.cwd, config: f.config, transport: f.transport });
    expect(report).toMatchObject({ schemaVersion: 2, ok: false, error: { code: 'SOURCE_UNSUPPORTED' } });
    expect(report.steps).toHaveLength(0); expect(f.queries()).toBe(0);
    expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  });
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
  // 发布决策的失败矩阵由 publication.test.ts 严格组件脚本覆盖；这里验证真实入口和Git服务器行为。
  it('releases its own lock on entry failure and records recovery after post-push verification failure', async () => {
    const f = await fixture(), lockPath = resolve(f.cwd, '.tmp/forge-vercel-release/publish.lock');
    const untracked = resolve(f.cwd, 'untracked.txt'); await writeFile(untracked, 'dirty');
    const refused = await f.run();
    expect(refused).toMatchObject({ ok: false, error: { code: 'GIT_DIRTY' }, effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } });
    expect(f.queries()).toBe(0); expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' }); await unlink(untracked);
    const transport: ReleaseTransport = { ...f.transport, api: (path, signal) => path.startsWith('/v4/aliases')
      ? Promise.resolve({ projectId: 'prj_fixture', deploymentId: 'dpl_other' }) : f.transport.api(path, signal) };
    const failed = await f.run('publish', { transport });
    expect(failed).toMatchObject({ ok: false, candidateSha: f.sha, error: { code: 'ALIAS_MISMATCH' },
      effects: { developmentPush: 'pushed', releasePush: 'pushed' },
      recovery: { candidateSha: f.sha, nextCommand: `forge-vercel-release verify --sha ${f.sha}` } });
    expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.sha);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = JSON.parse(await readFile(resolve(f.cwd, '.tmp/forge-vercel-release/latest-publish.json'), 'utf8'));
    expect(saved).toMatchObject({ schemaVersion: failed.schemaVersion, command: failed.command, ok: false,
      candidateSha: f.sha, error: failed.error, effects: failed.effects, recovery: failed.recovery });
    expect(Number.isFinite(Date.parse(saved.finishedAt))).toBe(true);
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
    const timed = await f.run('check');
    expect(timed.error?.code, JSON.stringify({ error: timed.error, steps: timed.steps, commands: commandFailures })).toBe('COMMAND_TIMEOUT');
    expect(commandFailures).toContainEqual(expect.objectContaining({ termination: 'timeout', identified: true }));
    const abort = new AbortController(); abort.abort();
    expect((await f.run('check', { signal: abort.signal })).error?.code).toBe('CANCELLED');
  });
});
