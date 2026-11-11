import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { ReleaseTransport } from '../../src/contracts.js';

const boundary = vi.hoisted(() => ({ counter: '', mode: 'ok' }));
// 只有创建部署的外部 CLI 被换成随仓库维护的真实 Node 子进程；Git、槽位、锁、事务及关闭协议均真实运行。
vi.mock('../../src/node/execution.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/node/execution.js')>();
  return { ...original, vercelInvocation: (args: readonly string[]) => {
    if (args[0] !== '--global-config' || args[2] !== 'deploy') throw new Error('unexpected CLI operation in controlled-cloud fixture');
    return { command: process.execPath, args: [resolve(import.meta.dirname, 'prebuilt-cli.mjs'), boundary.counter, boundary.mode, ...args] };
  } };
});
import { ReleaseError } from '../../src/node/errors.js';
import { managedFixture } from './managed-fixture.js';

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
  await writeFile(resolve(value.cwd, '.gitignore'), 'tmp/\nstate/\nnode_modules/\n.vercel/\n'); const sha = value.commit();
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
          'state/release-slot/checkout/state/forge-vercel-release/prebuilt/.vercel/output/static/.well-known/forge-prebuilt.json'), 'utf8')));
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


export { boundary, fixture };
