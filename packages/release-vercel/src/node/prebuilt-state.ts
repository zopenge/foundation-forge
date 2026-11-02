import type { PrebuiltReleaseState, ReleaseReport } from '../contracts.js';
import type { ExecutionContext, FrozenSource, ManagedSession, PrebuiltEffectResolution } from './release-context.js';
import { record, ReleaseError } from './errors.js';
import { candidateId, candidateOrigin } from './prebuilt-vercel.js';
import { measureManagedUsage } from './managed-io.js';
import { metadataReserveBytes } from './managed-metadata.js';

export function parsePrebuiltResolutions(value: unknown): readonly PrebuiltEffectResolution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new ReleaseError('SLOT_STATE', { reason: 'PREBUILT_RESOLUTIONS' });
  const runs = new Set<string>();
  for (const item of value.map(record)) {
    if (item.schemaVersion !== 1 || typeof item.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.runId) || runs.has(item.runId)
      || typeof item.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(item.sourceSha)
      || [item.configSha256, item.artifactSha256].some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
      || typeof item.deploymentId !== 'string' || !/^dpl_[a-zA-Z0-9]{1,120}$/u.test(item.deploymentId)
      || !['not-attempted', 'succeeded', 'failed'].includes(String(item.promotion)) || typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt))) {
      throw new ReleaseError('SLOT_STATE', { reason: 'PREBUILT_RESOLUTIONS' });
    }
    runs.add(item.runId);
  }
  return value as PrebuiltEffectResolution[];
}

export function parsePrebuiltState(value: unknown, source: FrozenSource, effects: ReleaseReport['effects']): PrebuiltReleaseState | undefined {
  const fail = (): never => { throw new ReleaseError('SLOT_STATE', { reason: 'PREBUILT_BINDING' }); };
  if (value === undefined) {
    if (effects.deploymentCreate !== undefined || effects.deploymentPromote !== undefined) fail();
    return;
  }
  const item = record(value), config = source.config.delivery;
  if (!config || item.sourceSha !== source.sha || item.configSha256 !== source.configSha256
    || typeof item.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.artifactSha256)
    || !Number.isSafeInteger(item.fileCount) || Number(item.fileCount) < 1 || Number(item.fileCount) > config.maxFiles
    || !Number.isSafeInteger(item.byteLength) || Number(item.byteLength) < 0 || Number(item.byteLength) > config.maxBytes
    || !['not-attempted', 'accepted', 'unknown'].includes(String(item.createEffect))
    || !['not-attempted', 'accepted', 'unknown'].includes(String(item.promoteEffect))
    || typeof item.acceptanceVerified !== 'boolean' || typeof item.promotionVerified !== 'boolean'
    || effects.deploymentCreate !== item.createEffect || effects.deploymentPromote !== item.promoteEffect) fail();
  if (item.deploymentId !== undefined || item.deploymentUrl !== undefined) {
    try { candidateId(item.deploymentId); if (candidateOrigin(item.deploymentUrl) !== item.deploymentUrl) fail(); } catch { fail(); }
  }
  if ((item.createEffect === 'accepted' && item.deploymentId === undefined)
    || (item.createEffect === 'not-attempted' && item.deploymentId !== undefined)
    || (item.acceptanceVerified && item.createEffect !== 'accepted')
    || (item.promoteEffect !== 'not-attempted' && (!item.acceptanceVerified || item.createEffect !== 'accepted'))
    || (item.promotionVerified && item.promoteEffect !== 'accepted')) fail();
  return value as PrebuiltReleaseState;
}

export function managedPrebuiltContext(session: ManagedSession): ExecutionContext['prebuilt'] {
  if (!session.slot.source.config.delivery) return;
  const context: NonNullable<ExecutionContext['prebuilt']> = {
    state: session.state.prebuilt,
    reserve: async bytes => {
      await session.slot.lock.assertOwned(); await session.budget.sample();
      const usage = await measureManagedUsage(session.slot.paths), limits = session.slot.source.config.source;
      if (limits.mode !== 'managed-commit' || usage.bytes + bytes + metadataReserveBytes > limits.maxBytes
        || usage.freeBytes - bytes < limits.minFreeBytes) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'ARTIFACT_COPY_ADMISSION' });
    },
    executionAt: cwd => session.executionAt(cwd),
    save: async value => {
      session.state.prebuilt = structuredClone(value);
      session.state.effects.deploymentCreate = value.createEffect;
      session.state.effects.deploymentPromote = value.promoteEffect;
      parsePrebuiltState(session.state.prebuilt, session.slot.source, session.state.effects);
      await session.persist(); context.state = session.state.prebuilt;
    },
  };
  return context;
}
