import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runRelease } from '../src/node.js';
import type { ReleaseConfig, ReleaseReport, ReleaseTransport, RunReleaseOptions } from '../src/contracts.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import { gitRoutingParameters } from './helpers/git-routing.js';
import { observeWindowsJobMembers } from '../../process-control-node/tests/helpers/windows-job-observer.js';

const lifecycleFailures = vi.hoisted((): { phase: string; name: string; code?: string; reason?: string; syscall?: string; entry?: string }[] => []);
function recordLifecycleFailure(phase: string, error: unknown): void {
  if (!error || typeof error !== 'object') { lifecycleFailures.push({ phase, name: typeof error }); return; }
  const code: unknown = Reflect.get(error, 'code'), details: unknown = Reflect.get(error, 'details');
  const reason: unknown = details && typeof details === 'object' ? Reflect.get(details, 'reason') : undefined;
  const safeCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);
  const syscall: unknown = Reflect.get(error, 'syscall'), path: unknown = Reflect.get(error, 'path');
  const entry = typeof path === 'string' ? basename(path) : undefined;
  lifecycleFailures.push({ phase, name: error instanceof Error ? error.name : 'object',
    ...(safeCode(code) ? { code } : {}), ...(safeCode(reason) ? { reason } : {}),
    ...(typeof syscall === 'string' && ['open', 'rename', 'unlink', 'write', 'fsync'].includes(syscall) ? { syscall } : {}),
    ...(entry && ['state.json', '.state.json.next', 'terminal.json', '.terminal.json.next'].includes(entry) ? { entry } : {}) });
}
// 透传真实 runner 与状态写入，只为失败断言保留错误分类，不记录环境或原始 cause。
vi.mock('@openge/forge-command-runner/node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-command-runner/node')>();
  return { ...actual, createNodeCommandRunner: (...args: Parameters<typeof actual.createNodeCommandRunner>) => {
    const runner = actual.createNodeCommandRunner(...args);
    return { ...runner, run: async (...parameters: Parameters<typeof runner.run>) => {
      const result = await runner.run(...parameters);
      for (const diagnostic of result.diagnostics) recordLifecycleFailure(diagnostic.code, diagnostic.cause ?? { code: diagnostic.code });
      return result;
    }, start: (...parameters: Parameters<typeof runner.start>) => {
      try {
        const running = runner.start(...parameters);
        return { ...running, result: running.result.catch((error: unknown) => { recordLifecycleFailure('command-result', error); throw error; }) };
      } catch (error) { recordLifecycleFailure('command-start', error); throw error; }
    } };
  } };
});
vi.mock('../src/node/managed-state.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-state.js')>();
  return { ...actual, createManagedStateStore: (...args: Parameters<typeof actual.createManagedStateStore>) => {
    const store = actual.createManagedStateStore(...args);
    return { ...store, writeState: async (...parameters: Parameters<typeof store.writeState>) => {
      try { return await store.writeState(...parameters); }
      catch (error) { recordLifecycleFailure('journal-write', error); throw error; }
    } };
  } };
});
let scopeObservation: Awaited<ReturnType<typeof observeWindowsJobMembers>> | undefined;
beforeEach(async () => {
  lifecycleFailures.length = 0;
  if (process.platform === 'win32' && process.arch === 'x64') scopeObservation = await observeWindowsJobMembers();
});

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const pending = new Set<Promise<ReleaseReport>>(), controllers = new Set<AbortController>();
async function run(options: RunReleaseOptions): Promise<ReleaseReport> {
  const controller = new AbortController(); controllers.add(controller);
  const task = runRelease({ ...options, signal: controller.signal }); pending.add(task);
  try { return await task; } finally { pending.delete(task); controllers.delete(controller); }
}
afterEach(async () => {
  try {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...pending]);
    vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) await f.dispose();
  } finally { scopeObservation?.restore(); scopeObservation = undefined; }
});
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };
async function configure(f: Awaited<ReturnType<typeof fixture>>, changes: Partial<ReleaseConfig>): Promise<string> {
  Object.assign(f.config, changes); await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); return f.commit();
}
it('checks an unpublished committed input in a real independent checkout, preserving unrelated files', { timeout: 180_000 }, async () => {
  const f = await fixture(); const unrelated = resolve(f.cwd, 'user-file'); await writeFile(unrelated, 'do not change');
  const sha = await configure(f, { checks: [{ command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),sha:require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),intent:process.env.FORGE_RELEASE_COMMAND,frozen:process.env.FORGE_RELEASE_SHA}))'] }] });
  const transport: ReleaseTransport = { api: async () => { throw new Error('check must not query Vercel'); }, buildInfo: async () => { throw new Error('check must not fetch online'); } };
  const report = await run({ cwd: f.cwd, command: 'check', transport });
  if (!report.ok) process.stderr.write(`managed-check command diagnostics: ${JSON.stringify(lifecycleFailures)}\n`);
  expect(report, JSON.stringify({ error: report.error, lifecycleFailures, members: scopeObservation?.members })).toMatchObject({ ok: true, schemaVersion: 2, candidateSha: sha, stage: 'complete', processes: { status: 'closed' } });
  expect(report.executionRoot).toBe(resolve(f.cwd, '.tmp/release-slot/checkout'));
  const checked = report.steps.find(step => step.name === 'check:0');
  expect(JSON.parse(checked?.stdout ?? '')).toEqual({ cwd: report.executionRoot, sha, intent: 'check', frozen: sha });
  expect(git(report.executionRoot ?? '', 'rev-parse', '--git-common-dir')).toBe('.git');
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  expect(await readFile(unrelated, 'utf8')).toBe('do not change');
});
it('refuses an object configuration override in managed mode', async () => {
  const f = await fixture();
  const report = await run({ cwd: f.cwd, command: 'check', config: f.config });
  expect(report).toMatchObject({ ok: false, error: { code: 'SOURCE_UNSUPPORTED' } });
});
it('reuses one clean slot at the same SHA and safely fast-forwards the next SHA', { timeout: 720_000 }, async () => {
  const f = await fixture();
  const first = await run({ cwd: f.cwd, command: 'check' }); expect(first.ok, JSON.stringify(first.error)).toBe(true);
  const dependency = resolve(first.executionRoot ?? '', 'node_modules/fixture-preserved'); await mkdir(resolve(first.executionRoot ?? '', 'node_modules'), { recursive: true });
  await writeFile(dependency, 'keep');
  const lock = await readFile(resolve(first.executionRoot ?? '', 'pnpm-lock.yaml'));
  const second = await run({ cwd: f.cwd, command: 'check' }); expect(second.ok, JSON.stringify(second.error)).toBe(true);
  await writeFile(resolve(f.cwd, 'source.txt'), 'next'); const sha = f.commit();
  const third = await run({ cwd: f.cwd, command: 'check' }); expect(third.ok, JSON.stringify(third.error)).toBe(true);
  expect(third).toMatchObject({ slotId: first.slotId, executionRoot: first.executionRoot, candidateSha: sha });
  expect(await readFile(dependency, 'utf8')).toBe('keep'); expect(await readFile(resolve(third.executionRoot ?? '', 'pnpm-lock.yaml'))).toEqual(lock);
});
it('stops after a preparation command modifies committed source', async () => {
  const f = await fixture();
  if (f.config.source.mode !== 'managed-commit') throw new Error('fixture mode');
  await configure(f, { source: { ...f.config.source, prepare: [{ command: 'node', args: ['-e', 'require("node:fs").writeFileSync("source.txt","changed")'] }] } });
  const report = await run({ cwd: f.cwd, command: 'check' });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: false, error: { code: 'CANDIDATE_CHANGED' } });
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
});
it('refuses a different pnpm version before frozen installation', async () => {
  const f = await fixture(); const manifest = JSON.parse(await readFile(resolve(f.cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(resolve(f.cwd, 'package.json'), JSON.stringify({ ...manifest, packageManager: 'pnpm@0.0.1' })); f.commit();
  const report = await run({ cwd: f.cwd, command: 'check' });
  expect(report).toMatchObject({ ok: false, stage: 'install', error: { code: 'SOURCE_UNSUPPORTED' } });
  expect(report.steps.some(step => step.name === 'install')).toBe(false);
});
it('publishes the exact managed SHA to two real refs and runs frozen acceptance', { timeout: 720_000 }, async () => {
  const f = await fixture(), declared = 'https://github.com/fixture/repository.git';
  vi.stubEnv('GIT_CONFIG_PARAMETERS', gitRoutingParameters(f.root, f.remote, declared));
  git(f.cwd, 'remote', 'set-url', 'origin', declared);
  await writeFile(resolve(f.cwd, 'user-note'), 'unrelated');
  const sha = await configure(f, { git: { ...f.config.git, repository: 'github.com/fixture/repository' },
    acceptance: [{ command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify([process.env.FORGE_RELEASE_COMMAND,process.env.FORGE_RELEASE_SHA,process.env.FORGE_RELEASE_URL,process.env.FORGE_RELEASE_DEPLOYMENT_ID]))'] }] });
  const deployment = { id: 'dpl_fixture', projectId: 'prj_fixture', target: 'production', readyState: 'READY', source: 'git',
    gitSource: { type: 'github', repoId: 101, org: 'fixture', repo: 'repository', sha, ref: 'main' }, url: 'fixture.vercel.app' };
  const transport: ReleaseTransport = { api: async path => {
    if (path.startsWith('/v9/projects')) return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
    if (path.startsWith('/v6/deployments')) return { deployments: [deployment] };
    if (path.startsWith('/v13/deployments')) return deployment;
    if (path.startsWith('/v4/aliases')) return { alias: 'fixture.example.invalid', deploymentId: deployment.id, projectId: deployment.projectId };
    throw new Error('unexpected fixture API path');
  }, buildInfo: async () => ({ revision: sha }) };
  const report = await run({ cwd: f.cwd, command: 'publish', transport });
  expect(report, JSON.stringify({ error: report.error, lifecycleFailures })).toMatchObject({ ok: true, candidateSha: sha, stage: 'complete', effects: { developmentPush: 'pushed', releasePush: 'pushed' }, processes: { status: 'closed' }, budget: { observationsComplete: true } });
  expect(f.ref('dev')).toBe(sha); expect(f.ref('main')).toBe(sha); expect(git(f.cwd, 'branch', '--show-current')).toBe('dev');
  expect(await readFile(resolve(f.cwd, 'user-note'), 'utf8')).toBe('unrelated');
  expect(JSON.parse(report.steps.find(step => step.name === 'acceptance:0')?.stdout ?? '')).toEqual(['publish', sha, f.config.vercel.productionUrl, deployment.id]);
  const receiptPath = resolve(f.cwd, '.tmp/release-slot/latest-publish.json'), anchorPath = resolve(f.cwd, '.tmp/forge-vercel-release/managed.json');
  const receipt = await readFile(receiptPath), anchor = await readFile(anchorPath);
  await configure(f, { vercel: { ...f.config.vercel, projectId: 'prj_changed' }, acceptance: [{ command: 'node', args: ['-e', 'process.exit(99)'] }] });
  const verified = await run({ cwd: f.cwd, command: 'verify', transport });
  expect(verified, JSON.stringify(verified.error)).toMatchObject({ ok: true, candidateSha: sha, processes: { status: 'closed' } });
  expect(JSON.parse(verified.steps.find(step => step.name === 'acceptance:0')?.stdout ?? '')).toEqual(['verify', sha, 'https://fixture.example.invalid', deployment.id]);
  expect(verified.steps.some(step => step.name === 'install' || step.name.startsWith('push:'))).toBe(false);
  expect(await readFile(receiptPath)).toEqual(receipt); expect(await readFile(anchorPath)).toEqual(anchor);
  expect(f.ref('dev')).toBe(sha); expect(f.ref('main')).toBe(sha);
});
