import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReleaseConfig, ReleaseTransport } from '../../src/contracts.js';
import { ReleaseError } from '../../src/node/errors.js';
import { managedFixture } from './managed-fixture.js';

/** 真实独立 Git/checkout 与原 native runner；仅云 API 和部署 CLI 由受控边界提供。 */
export async function completionFixture({ completion = true, mode = 'ok', jobTimeoutMs }: { completion?: boolean; mode?: string; jobTimeoutMs?: number } = {}) {
  const value = await managedFixture();
  try {
    if (value.config.source.mode !== 'managed-commit') throw new Error('managed source required');
    const createCounter = resolve(value.root, 'creates.txt'), control = resolve(value.root, 'completion-mode.txt');
    const proof = resolve(value.root, 'production-proof.json'), observations = resolve(value.root, 'completion-observations.jsonl');
    const config: ReleaseConfig = { ...value.config, delivery: { mode: 'prebuilt', maxFiles: 100, maxBytes: 1_048_576,
      versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' },
      concurrencyControl: { mode: 'external-serialization', scope: 'fixture-project' },
      admission: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] },
    source: { ...value.config.source, prepare: [{ command: 'node', args: ['-e',
      'const f=require("node:fs");f.mkdirSync(".vercel/output/static",{recursive:true});f.writeFileSync(".vercel/output/config.json",JSON.stringify({version:3}));f.writeFileSync(".vercel/output/static/index.html","candidate");process.stdout.write(JSON.stringify({url:process.env.FORGE_RELEASE_VERSION_URL,config:process.env.FORGE_RELEASE_CONFIG_SHA256,context:process.env.FORGE_RELEASE_CANDIDATE_CONTEXT}));'] }] },
    ...(completion ? { completion: { idempotent: true, jobs: [{ command: 'node',
      args: [resolve(import.meta.dirname, '../../package-consumer/completion-job.mjs'), control, proof, observations],
      ...(jobTimeoutMs === undefined ? {} : { timeoutMs: jobTimeoutMs }) }] } } : {}) };
    await writeFile(control, mode);
    await writeFile(resolve(value.cwd, '.gitignore'), 'tmp/\nstate/\nnode_modules/\n.vercel/\n');
    await writeFile(resolve(value.cwd, 'release.config.json'), JSON.stringify(config));
    const sha = value.commit(), trace: string[] = [];
    const markers = new Map<string, Record<string, unknown>>(), versions = new Map<string, string>();
    const hooks: { marker?: (value: unknown) => unknown; promotion?: () => void; production?: () => Promise<void> } = {};
    let production: string | undefined, promotions = 0, assignments = 0;
    const transport: ReleaseTransport = {
      api: async path => {
        trace.push(`api:${path}`);
        if (path.startsWith('/v9/projects/')) return { id: 'prj_fixture', accountId: 'team_fixture', link: null,
          ...(production ? { lastAliasRequest: { type: 'promote', jobStatus: 'succeeded', toDeploymentId: production } } : {}) };
        if (path.startsWith('/v13/deployments/')) {
          const id = path.split('/')[3]?.split('?')[0]; if (!id) throw new Error('deployment required');
          if (!markers.has(id)) markers.set(id, JSON.parse(await readFile(resolve(value.cwd,
            'state/release-slot/checkout/state/forge-vercel-release/prebuilt/.vercel/output/static/.well-known/forge-prebuilt.json'), 'utf8')));
          return { id, ownerId: 'team_fixture', projectId: 'prj_fixture', target: 'production', source: 'cli', readyState: 'READY', url: `${id.slice(4)}.vercel.app` };
        }
        if (path.startsWith('/v4/aliases/')) {
          if (!production) throw new ReleaseError('ALIAS_MISMATCH');
          return { alias: 'fixture.example.invalid', projectId: 'prj_fixture', deploymentId: production };
        }
        throw new Error(`unexpected API path ${path}`);
      },
      buildInfo: async url => {
        const parsed = new URL(url), stable = parsed.hostname === 'fixture.example.invalid';
        const id = stable ? production : versions.get(parsed.hostname) ?? `dpl_${parsed.hostname.split('.')[0]}`;
        const marker = id ? markers.get(id) : undefined; if (!marker) throw new Error('unknown deployment');
        trace.push(`read:${parsed.hostname}:${parsed.pathname}`);
        if (parsed.pathname === '/.well-known/forge-prebuilt.json') return hooks.marker?.(marker) ?? marker;
        if (stable) {
          await hooks.production?.();
          await writeFile(proof, JSON.stringify({ ...marker, deploymentId: id, productionUrl: 'https://fixture.example.invalid' }));
        }
        return { revision: marker.sourceSha };
      },
      promote: async id => { promotions++; production = id; trace.push('promote'); hooks.promotion?.(); },
      versionAlias: {
        read: async hostname => { const deploymentId = versions.get(hostname); return deploymentId
          ? { alias: hostname, projectId: 'prj_fixture', deploymentId, routing: 'direct' } : undefined; },
        assign: async (id, hostname) => { assignments++; versions.set(hostname, id); return { alias: hostname, uid: 'fixtureAlias' }; },
      },
    };
    return { ...value, config, sha, createCounter, control, proof, observations, transport, trace, hooks,
      counts: async () => ({ creates: Number(await readFile(createCounter, 'utf8')), promotions, assignments }),
      results: async (): Promise<Record<string, unknown>[]> => {
        const text = await readFile(observations, 'utf8').catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error;
        });
        return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      } };
  } catch (error) { await value.dispose(); throw error; }
}
