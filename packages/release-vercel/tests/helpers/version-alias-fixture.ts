import { expect } from 'vitest';
import type { VersionAliasAssignment, VersionAliasBinding } from '../../src/contracts.js';
import { prebuiltFixture } from './prebuilt-fixture.js';

/** 保留实际 artifact 和发布引擎，只替换受控云端的 alias 读写边界。 */
export async function versionAliasFixture() {
  const fixture = await prebuiltFixture();
  Object.assign(fixture.config.delivery, { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } });
  const hostname = `fixture-${'a'.repeat(40)}.vercel.app`;
  const bindings = new Map<string, VersionAliasBinding>();
  const hooks: { read?: (hostname: string) => void | Promise<void>;
    assign?: (hostname: string, signal: AbortSignal) => Promise<VersionAliasAssignment> } = {};
  let writes = 0;
  Object.assign(fixture.context.transport ?? {}, { versionAlias: {
    read: async (host: string) => { fixture.trace.push(`alias-read:${host}`); await hooks.read?.(host); return bindings.get(host); },
    assign: async (id: string, host: string, signal: AbortSignal) => {
      expect(id).toBe('dpl_candidate'); expect(host).toBe(hostname);
      expect(fixture.snapshots.at(-1)?.versionAlias).toMatchObject({ hostname, effect: 'unknown', verified: false });
      writes++; fixture.trace.push('alias-assign');
      bindings.set(host, { alias: host, projectId: 'prj_fixture', deploymentId: id, routing: 'direct' });
      return hooks.assign ? hooks.assign(host, signal) : { alias: host, uid: 'alias_fixture' };
    },
  } });
  return { ...fixture, hostname, bindings, aliasHooks: hooks, aliasWrites: () => writes };
}
