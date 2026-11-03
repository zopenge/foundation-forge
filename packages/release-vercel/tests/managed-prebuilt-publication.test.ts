import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseTransport } from '../src/contracts.js';

const boundary = vi.hoisted(() => ({ counter: '', mode: 'ok' }));
// 只有创建部署的外部 CLI 被换成随仓库维护的真实 Node 子进程；Git、槽位、锁、事务及关闭协议均真实运行。
vi.mock('../src/node/execution.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/node/execution.js')>();
  return { ...original, vercelInvocation: (args: readonly string[]) => {
    if (args[0] !== '--global-config' || args[2] !== 'deploy') throw new Error('unexpected CLI operation in controlled-cloud fixture');
    return { command: process.execPath, args: [resolve(import.meta.dirname, 'helpers/prebuilt-cli.mjs'), boundary.counter, boundary.mode, ...args] };
  } };
});
import { runRelease } from '../src/node.js';
import { ReleaseError } from '../src/node/errors.js';
import { managedFixture } from './helpers/managed-fixture.js';

const owned: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const fixture of owned.splice(0)) await fixture.dispose(); boundary.counter = ''; boundary.mode = 'ok'; });
async function fixture(withAlias = false) {
  const value = await managedFixture(); owned.push(value);
  if (value.config.source.mode !== 'managed-commit') throw new Error('managed source required');
  const config = { ...value.config, delivery: { mode: 'prebuilt', maxFiles: 100, maxBytes: 1_048_576,
    ...(withAlias ? { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } } : {}),
    concurrencyControl: { mode: 'external-serialization', scope: 'fixture-project' },
    admission: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] },
  source: { ...value.config.source, prepare: [{ command: 'node', args: ['-e',
    'const f=require("node:fs");f.mkdirSync(".vercel/output/static",{recursive:true});f.writeFileSync(".vercel/output/config.json",JSON.stringify({version:3}));f.writeFileSync(".vercel/output/static/index.html","candidate");'] }] } };
  await writeFile(resolve(value.cwd, 'release.config.json'), JSON.stringify(config));
  await writeFile(resolve(value.cwd, '.gitignore'), '.tmp/\nnode_modules/\n.vercel/\n'); const sha = value.commit();
  boundary.counter = resolve(value.root, 'create-count.txt');
  let aliased: string | undefined, promotions = 0, assignments = 0; const paths: string[] = [];
  const versionBindings = new Map<string, string>();
  const markers = new Map<string, Record<string, unknown>>(), jobs = new Map<string, string>();
  const hooks: { promote?: () => void; failPromotion?: boolean; alias?: () => void; versionRead?: () => void; project?: () => Promise<void> } = {};
  const transport: ReleaseTransport = {
    api: async path => {
      paths.push(path);
      if (path.startsWith('/v9/projects/')) {
        await hooks.project?.();
        return { id: 'prj_fixture', accountId: 'team_fixture', link: null,
          ...(aliased ? { lastAliasRequest: { type: 'promote', jobStatus: jobs.get(aliased), toDeploymentId: aliased } } : {}) };
      }
      if (path.startsWith('/v13/deployments/dpl_candidate')) {
        const id = path.split('/')[3]?.split('?')[0]; if (!id) throw new Error('deployment ID required');
        if (!markers.has(id)) markers.set(id, JSON.parse(await readFile(resolve(value.cwd,
          '.tmp/release-slot/checkout/.tmp/forge-vercel-release/prebuilt/.vercel/output/static/.well-known/forge-prebuilt.json'), 'utf8')));
        return { id, ownerId: 'team_fixture', projectId: 'prj_fixture', target: 'production', source: 'cli', readyState: 'READY', url: `${id.slice(4)}.vercel.app` };
      }
      if (path.startsWith('/v4/aliases/')) {
        if (!aliased) throw new ReleaseError('ALIAS_MISMATCH');
        return { alias: 'fixture.example.invalid', projectId: 'prj_fixture', deploymentId: aliased };
      }
      throw new Error(`unexpected API request: ${path}`);
    },
    buildInfo: async url => {
      const parsed = new URL(url), id = parsed.hostname === 'fixture.example.invalid' ? aliased
        : versionBindings.get(parsed.hostname) ?? `dpl_${parsed.hostname.split('.')[0]}`;
      if (versionBindings.has(parsed.hostname)) hooks.versionRead?.();
      const marker = id ? markers.get(id) : undefined; if (!marker) throw new Error('unknown controlled deployment');
      return parsed.pathname === '/.well-known/forge-prebuilt.json' ? marker : { revision: marker.sourceSha };
    },
    promote: async id => { promotions++; aliased = id; jobs.set(id, hooks.failPromotion ? 'failed' : 'succeeded'); hooks.promote?.(); },
    ...(withAlias ? { versionAlias: {
      read: async (hostname: string) => { const deploymentId = versionBindings.get(hostname);
        return deploymentId ? { alias: hostname, projectId: 'prj_fixture', deploymentId, routing: 'direct' as const } : undefined; },
      assign: async (id: string, hostname: string) => { assignments++; versionBindings.set(hostname, id); hooks.alias?.();
        return { alias: hostname, uid: 'fixtureAlias' }; },
    } } : {}),
  };
  return { ...value, sha, transport, hooks, paths, promotions: () => promotions,
    assignments: () => assignments, versionBindings,
    creates: async () => Number(await readFile(boundary.counter, 'utf8')) };
}

describe('managed prebuilt candidate recovery through public entry', () => {
  it.each(['unknown', 'accepted'])('resumes the same candidate after explicit readonly verification of an %s alias', async effect => {
    const value = await fixture(true);
    if (effect === 'unknown') value.hooks.alias = () => { throw new ReleaseError('VERCEL_API'); };
    else value.hooks.versionRead = () => { throw new ReleaseError('BUILD_INFO', { status: 503 }); };
    const first = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(first, JSON.stringify(first.error)).toMatchObject({ ok: false, prebuilt: {
      deploymentId: 'dpl_candidate', versionAlias: { effect, verified: false } } });
    const receipt = resolve(value.cwd, '.tmp/release-slot/latest-publish.json'), original = await readFile(receipt);
    delete value.hooks.alias; delete value.hooks.versionRead;
    const verified = await runRelease({ command: 'verify', cwd: value.cwd, transport: value.transport });
    expect(verified, JSON.stringify(verified.error)).toMatchObject({ ok: true, candidateContext: { versionAliasVerified: true } });
    expect(await readFile(receipt)).toEqual(original);
    expect(value.promotions()).toBe(0);
    const published = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(published, JSON.stringify(published.error)).toMatchObject({ ok: true, candidateSha: value.sha,
      prebuilt: { deploymentId: 'dpl_candidate', promotionVerified: true } });
    expect(await value.creates()).toBe(1); expect(value.assignments()).toBe(1); expect(value.promotions()).toBe(1);
    const current = JSON.parse(await readFile(resolve(value.cwd, '.tmp/release-slot/state.json'), 'utf8'));
    expect(current.prebuiltResolutions).toEqual(expect.arrayContaining([expect.objectContaining({
      runId: first.runId, sourceSha: value.sha, configSha256: first.configSha256, artifactSha256: first.prebuilt?.artifactSha256,
      deploymentId: 'dpl_candidate', versionAlias: { hostname: `fixture-${value.sha}.vercel.app`, verified: true },
    })]));
    const archive = JSON.parse(await readFile(resolve(value.cwd, `.tmp/release-slot/history/${first.runId}.json`), 'utf8'));
    expect(archive.stopped.prebuilt.versionAlias).toMatchObject({ effect, verified: false });
  }, 300_000);
  it('persists alias uncertainty, exposes readonly context, and proves the original binding before a new candidate', async () => {
    const value = await fixture(true);
    value.hooks.alias = () => { throw new ReleaseError('VERCEL_API'); };
    const first = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(first, JSON.stringify(first.error)).toMatchObject({ ok: false, error: { code: 'VERCEL_API' },
      prebuilt: { deploymentId: 'dpl_candidate', versionAlias: { effect: 'unknown', verified: false } },
      effects: { versionAliasAssign: 'unknown' } });
    const receipt = resolve(value.cwd, '.tmp/release-slot/latest-publish.json');
    const before = await readFile(receipt);
    let verificationRunId = '';
    for (const command of ['status', 'verify'] as const) {
      const observed = await runRelease({ command, cwd: value.cwd, transport: value.transport });
      expect(observed, JSON.stringify(observed.error)).toMatchObject({ ok: true, candidateContext: {
        teamId: 'team_fixture', projectId: 'prj_fixture', sourceSha: value.sha, deploymentId: 'dpl_candidate',
        versionUrl: `https://fixture-${value.sha}.vercel.app`, versionAliasVerified: true,
        configSha256: first.configSha256, artifactSha256: first.prebuilt?.artifactSha256,
      } });
      if (command === 'verify') verificationRunId = observed.runId ?? '';
    }
    expect(await readFile(receipt)).toEqual(before);
    expect(await value.creates()).toBe(1); expect(value.assignments()).toBe(1); expect(value.promotions()).toBe(0);
    delete value.hooks.alias;
    await writeFile(resolve(value.cwd, 'source.txt'), 'new alias candidate\n'); const nextSha = value.commit();
    expect(verificationRunId).toMatch(/^[a-f0-9-]{36}$/u);
    let proofCheckedBeforeCreate = false;
    value.hooks.project = async () => {
      expect(await value.creates()).toBe(1);
      const archive = JSON.parse(await readFile(resolve(value.cwd, `.tmp/release-slot/history/${verificationRunId}.json`), 'utf8'));
      expect(archive).toMatchObject({ stopped: { runId: verificationRunId, command: 'verify' }, outcome: { ok: true } });
      expect(archive.stopped.prebuiltResolutions).toEqual(expect.arrayContaining([expect.objectContaining({ runId: first.runId,
        sourceSha: value.sha, configSha256: first.configSha256, artifactSha256: first.prebuilt?.artifactSha256, deploymentId: 'dpl_candidate',
        versionAlias: { hostname: `fixture-${value.sha}.vercel.app`, verified: true } })]));
      proofCheckedBeforeCreate = true; delete value.hooks.project;
    };
    const next = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(next, JSON.stringify(next.error)).toMatchObject({ ok: true, candidateSha: nextSha,
      candidateContext: { deploymentId: 'dpl_candidate2', versionAliasVerified: true } });
    expect(await value.creates()).toBe(2); expect(value.assignments()).toBe(2); expect(value.promotions()).toBe(1);
    expect(proofCheckedBeforeCreate).toBe(true);
    expect(value.versionBindings.get(`fixture-${value.sha}.vercel.app`)).toBe('dpl_candidate');
  }, 300_000);
  it('publishes once and observes the saved exact ID through status and verify without Git integration', async () => {
    const value = await fixture();
    const published = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(published, JSON.stringify(published.error)).toMatchObject({ ok: true, processes: { status: 'closed' },
      prebuilt: { deploymentId: 'dpl_candidate', promotionVerified: true } });
    const before = await readFile(resolve(value.cwd, '.tmp/release-slot/latest-publish.json'));
    for (const command of ['status', 'verify'] as const) {
      const observed = await runRelease({ command, cwd: value.cwd, transport: value.transport });
      expect(observed, JSON.stringify(observed.error)).toMatchObject({ ok: true, candidateSha: value.sha, deployment: { id: 'dpl_candidate' } });
    }
    expect(await readFile(resolve(value.cwd, '.tmp/release-slot/latest-publish.json'))).toEqual(before);
    expect(await value.creates()).toBe(1); expect(value.promotions()).toBe(1);
    expect(value.paths.every(path => !path.startsWith('/v6/deployments'))).toBe(true);
    expect(value.ref('dev')).toBe(value.initial); expect(value.ref('main')).toBe(value.initial);
  }, 300_000);
  it('retains an unknown creation across source fast-forward and refuses to create again', async () => {
    const value = await fixture(); boundary.mode = 'lost-response';
    const failed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(failed).toMatchObject({ ok: false, processes: { status: 'closed' }, prebuilt: { createEffect: 'unknown' } });
    await writeFile(resolve(value.cwd, 'source.txt'), 'next source\n'); value.commit(); boundary.mode = 'ok';
    const resumed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(resumed, JSON.stringify(resumed.error)).toMatchObject({ ok: false, error: { code: 'RECOVERY_REQUIRED' } });
    expect(await value.creates()).toBe(1); expect(value.promotions()).toBe(0);
  }, 300_000);
  it('observes an accepted promotion with a lost response and never promotes the candidate twice', async () => {
    const value = await fixture(); value.hooks.promote = () => { throw new ReleaseError('VERCEL_API'); };
    const failed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(failed).toMatchObject({ ok: false, prebuilt: { deploymentId: 'dpl_candidate', promoteEffect: 'unknown' } });
    delete value.hooks.promote;
    const observed = await runRelease({ command: 'status', cwd: value.cwd, transport: value.transport });
    expect(observed, JSON.stringify(observed.error)).toMatchObject({ ok: true, deployment: { id: 'dpl_candidate' } });
    const resumed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(resumed, JSON.stringify(resumed.error)).toMatchObject({ ok: true, prebuilt: { deploymentId: 'dpl_candidate', promotionVerified: true } });
    expect(await value.creates()).toBe(1); expect(value.promotions()).toBe(1);
  }, 300_000);
  it.each(['lost-response', 'failed-job'])('keeps a proved old promotion settled after later candidates change the production alias: %s', async kind => {
    const value = await fixture();
    if (kind === 'lost-response') value.hooks.promote = () => { throw new ReleaseError('VERCEL_API'); };
    else value.hooks.failPromotion = true;
    const first = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(first).toMatchObject({ ok: false, prebuilt: { promoteEffect: kind === 'lost-response' ? 'unknown' : 'accepted' } });
    delete value.hooks.promote; delete value.hooks.failPromotion;
    const observed = await runRelease({ command: 'status', cwd: value.cwd, transport: value.transport }); expect(observed.ok).toBe(kind === 'lost-response');
    for (const name of ['second', 'third']) {
      await writeFile(resolve(value.cwd, 'source.txt'), `${name}\n`); value.commit();
      const published = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
      expect(published, JSON.stringify(published.error)).toMatchObject({ ok: true, prebuilt: { promotionVerified: true } });
    }
    expect(await value.creates()).toBe(3); expect(value.promotions()).toBe(3);
  }, 300_000);
});
