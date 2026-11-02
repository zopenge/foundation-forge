import type { PrebuiltReleaseState, ReleaseConfig, ReleaseTransport } from '../contracts.js';
import type { ManagedState, PrebuiltEffectResolution } from './release-context.js';
import type { Execution } from './execution.js';
import { createPrebuiltTransport, PrebuiltVerification } from './prebuilt-vercel.js';
import { assertActive, ReleaseError } from './errors.js';

/** 原始回执不改写；返回本次独立观察到的状态，不能用当前 manifest 补造旧绑定。 */
export async function observePrebuiltCandidate(config: ReleaseConfig, state: PrebuiltReleaseState | undefined,
  transport: ReleaseTransport, signal?: AbortSignal) {
  if (!state?.deploymentId) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_CANDIDATE_ID_MISSING' });
  const verify = new PrebuiltVerification(config, transport, signal);
  await verify.project(undefined, true); const deployment = await verify.ready(state);
  const observed: PrebuiltReleaseState = { ...state, createEffect: 'accepted' };
  if (state.promoteEffect !== 'not-attempted') {
    await verify.alias(state); observed.promoteEffect = 'accepted'; observed.promotionVerified = true;
  }
  return { deployment, observed };
}
export function hasUnresolvedPrebuiltEffect(state: ManagedState): boolean {
  const candidate = state.prebuilt;
  return !!candidate && (candidate.createEffect === 'unknown' || candidate.promoteEffect === 'unknown'
    || (candidate.promoteEffect === 'accepted' && !candidate.promotionVerified));
}
export async function assertPrebuiltEffectObserved(state: ManagedState, execution: Execution, transport?: ReleaseTransport): Promise<PrebuiltEffectResolution | undefined> {
  if (!hasUnresolvedPrebuiltEffect(state)) return;
  const candidate = state.prebuilt; if (!candidate) return;
  if (!candidate.deploymentId) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_CREATE_UNKNOWN', runId: state.runId });
  const verify = new PrebuiltVerification(state.source.config, transport ?? createPrebuiltTransport(execution, state.source.config, false), execution.signal);
  await verify.project(undefined, true); await verify.candidate(candidate);
  let promotion: PrebuiltEffectResolution['promotion'] = 'not-attempted';
  if (candidate.promoteEffect !== 'not-attempted') {
    try {
      promotion = await verify.promotion(candidate) === 'failed' ? 'failed' : 'succeeded';
      if (promotion === 'succeeded') { await verify.ready(candidate); await verify.alias(candidate); }
    }
    catch (error) {
      assertActive(execution.signal);
      if (error instanceof ReleaseError && error.code === 'ALIAS_MISMATCH') throw new ReleaseError('RECOVERY_REQUIRED', {
        reason: 'PREBUILT_PROMOTION_UNRESOLVED', runId: state.runId, deploymentId: candidate.deploymentId });
      throw error;
    }
  }
  return { schemaVersion: 1, runId: state.runId, sourceSha: state.source.sha, configSha256: state.source.configSha256,
    artifactSha256: candidate.artifactSha256, deploymentId: candidate.deploymentId,
    promotion, observedAt: new Date().toISOString() };
}
/** 观察证据必须引用同一槽中已封存的原始意图；不能只凭 runId 消除未知效果。 */
export function matchesPrebuiltResolution(state: ManagedState, proof: PrebuiltEffectResolution): boolean {
  const candidate = state.prebuilt;
  return !!candidate && state.runId === proof.runId && state.source.sha === proof.sourceSha
    && state.source.configSha256 === proof.configSha256 && candidate.artifactSha256 === proof.artifactSha256
    && candidate.deploymentId === proof.deploymentId
    && (candidate.promoteEffect === 'not-attempted' ? proof.promotion === 'not-attempted' : ['succeeded', 'failed'].includes(proof.promotion));
}
