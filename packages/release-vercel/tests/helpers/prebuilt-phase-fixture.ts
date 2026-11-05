import { publishCandidate } from '../../src/node/publication.js';
import { prebuiltConfiguration } from './prebuilt-configuration.js';
import { prebuiltFixture } from './prebuilt-fixture.js';
import { managedPhaseSession } from './managed-phase-session.js';
import type { ReleaseConfig, ReleaseTransport } from '../../src/contracts.js';
import { record } from '../../src/node/errors.js';
import { managedPrebuiltContext } from '../../src/node/prebuilt-state.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 阶段输入不包含真实命令；OS接入由独立Native代表与tarball验证。 */
export async function prebuiltPhaseFixture({ withAlias = false, completion, signal }:
  { withAlias?: boolean; completion?: ReleaseConfig['completion']; signal?: AbortSignal } = {}) {
  const delivery = { ...prebuiltConfiguration().delivery,
    ...(completion ? { admission: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] } : {}),
    ...(withAlias ? { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } } : {}) };
  const base = await managedPhaseSession({ extraConfig: { delivery, ...(completion ? { completion } : {}) } }, signal);
  try {
  if (!base.config.delivery) throw new Error('prebuilt phase configuration required');
  const engine = await prebuiltFixture({ sha: base.sha, config: { ...base.config, delivery: base.config.delivery },
    root: base.session.execution.cwd });
  // 此目录只承担生产输入封存，Git来源准入仍由完整Native入口验证。
  await mkdir(resolve(engine.root, '.git'), { recursive: true });
  const original = engine.context.transport; if (!original) throw new Error('controlled phase transport required');
  const hooks: { promote?: () => void; failPromotion?: boolean; alias?: () => void; versionRead?: () => void } = {};
  const bindings = new Map<string, string>(); let assignments = 0;
  const transport: ReleaseTransport = { ...original,
    api: async (path, signal) => {
      const response = await original.api(path, signal);
      return path.startsWith('/v9/projects/') && hooks.failPromotion ? { ...record(response),
        lastAliasRequest: { type: 'promote', toDeploymentId: 'dpl_candidate', jobStatus: 'failed' } } : response;
    },
    buildInfo: async (url, signal) => {
      if (bindings.has(new URL(url).hostname)) hooks.versionRead?.();
      return original.buildInfo(url, signal);
    },
    promote: async (id, signal) => {
      if (!original.promote) throw new Error('controlled promotion required');
      await original.promote(id, signal); hooks.promote?.();
    },
    versionAlias: {
      read: async hostname => { const id = bindings.get(hostname); return id
        ? { alias: hostname, projectId: 'prj_fixture', deploymentId: id, routing: 'direct' as const } : undefined; },
      assign: async (id, hostname) => { assignments++; bindings.set(hostname, id); hooks.alias?.(); return { alias: hostname, uid: 'phaseAlias' }; },
    },
  };
  const publish = () => publishCandidate({ ...engine.context, transport, effects: base.session.state.effects,
    stage: async stage => { base.session.state.stage = stage; await base.session.persist(); },
    prebuilt: { ...engine.prebuilt, state: base.session.state.prebuilt, save: async value => {
      await engine.prebuilt.save(value);
      const managed = managedPrebuiltContext(base.session); if (!managed) throw new Error('managed prebuilt context required');
      await managed.save(value);
    } } }, 'publish');
  return { ...base, get session() { return base.session; }, engine, publish, transport, hooks, assignments: () => assignments,
    dispose: async () => { try { await engine.dispose(); } finally { await base.dispose(); } } };
  } catch (error) { await base.dispose(); throw error; }
}
