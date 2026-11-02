import { setTimeout as delay } from 'node:timers/promises';
import type { PrebuiltReleaseState, VersionAliasBinding, VersionAliasTransport } from '../contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';
import type { PrebuiltVerification } from './prebuilt-vercel.js';
import { request } from './vercel.js';
import { versionAliasOrigin } from './version-alias.js';

const conflict = (reason: string) => new ReleaseError('VERSION_ALIAS_CONFLICT', { reason });
export function versionAliasTransport(verify: PrebuiltVerification, writing = false): VersionAliasTransport {
  const adapter = verify.transport.versionAlias;
  if (!adapter || typeof adapter.read !== 'function' || (writing && typeof adapter.assign !== 'function'))
    throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'VERSION_ALIAS_TRANSPORT_REQUIRED' });
  return adapter;
}
async function readBinding(verify: PrebuiltVerification, hostname: string, deadline?: number): Promise<VersionAliasBinding | undefined> {
  const remaining = deadline === undefined ? verify.config.limits.requestMs : Math.min(verify.config.limits.requestMs, deadline - Date.now());
  if (remaining <= 0) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'VERSION_ALIAS_UNCONFIRMED' });
  const adapter = versionAliasTransport(verify);
  const value = await request(signal => adapter.read(hostname, signal), remaining, verify.signal);
  if (value === undefined) return;
  const item = record(value);
  if (item.alias !== hostname || item.projectId !== verify.config.vercel.projectId || item.routing !== 'direct'
    || typeof item.deploymentId !== 'string' || !/^dpl_[a-zA-Z0-9]{1,120}$/u.test(item.deploymentId)
    || item.redirect != null || item.microfrontends != null || item.deletedAt != null) throw conflict('BINDING_UNCONFIRMED');
  return { alias: hostname, projectId: String(item.projectId), deploymentId: item.deploymentId, routing: 'direct' };
}
export async function assertVersionAliasAvailable(verify: PrebuiltVerification, hostname: string): Promise<void> {
  if (await readBinding(verify, hostname)) throw conflict('HOSTNAME_OCCUPIED');
}
async function bindingForCandidate(verify: PrebuiltVerification, state: PrebuiltReleaseState, deadline?: number): Promise<boolean> {
  const alias = state.versionAlias;
  const origin = versionAliasOrigin(verify.config, state.sourceSha);
  if (!alias || !state.deploymentId || !origin || new URL(origin).hostname !== alias.hostname)
    throw new ReleaseError('SLOT_STATE', { reason: 'VERSION_ALIAS_BINDING' });
  const binding = await readBinding(verify, alias.hostname, deadline);
  if (!binding) return false;
  if (binding.deploymentId !== state.deploymentId) throw conflict('DEPLOYMENT_MISMATCH');
  return true;
}
/** 未决效果只观察原绑定；不存在不能证明原POST从未执行，更不能补发。 */
export async function observeVersionAlias(verify: PrebuiltVerification, state: PrebuiltReleaseState): Promise<void> {
  if (!verify.config.delivery?.versionAlias) return;
  const deadline = Date.now() + verify.config.limits.deploymentMs;
  do {
    assertActive(verify.signal);
    if (await bindingForCandidate(verify, state, deadline)) {
      const origin = versionAliasOrigin(verify.config, state.sourceSha);
      if (!origin) throw new ReleaseError('SLOT_STATE');
      try {
        await verify.marker(state, origin, deadline);
        const url = new URL(verify.config.buildInfo.path, origin); url.searchParams.set('revision', state.sourceSha);
        const remaining = Math.min(verify.config.limits.requestMs, deadline - Date.now());
        if (remaining <= 0) break;
        const info = record(await request(signal => verify.transport.buildInfo(url.href, signal), remaining, verify.signal));
        if (info[verify.config.buildInfo.revisionField] !== state.sourceSha) throw new ReleaseError('BUILD_REVISION');
        if (await bindingForCandidate(verify, state, deadline)) return;
      } catch (error) {
        assertActive(verify.signal);
        if (!(error instanceof ReleaseError) || error.code !== 'BUILD_INFO' || error.details.status !== 404) throw error;
      }
    }
    const remaining = deadline - Date.now(); if (remaining <= 0) break;
    try { await delay(Math.min(verify.config.limits.pollMs, remaining), undefined, verify.signal ? { signal: verify.signal } : {}); }
    catch (error) { assertActive(verify.signal); throw error; }
  } while (Date.now() < deadline);
  throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'VERSION_ALIAS_UNCONFIRMED' });
}

export async function bindVersionAlias(verify: PrebuiltVerification, selected: PrebuiltReleaseState,
  save: (state: PrebuiltReleaseState) => Promise<PrebuiltReleaseState>, guard: () => Promise<void>,
  admit: () => Promise<void>, custom: boolean): Promise<PrebuiltReleaseState> {
  const alias = selected.versionAlias;
  if (!alias) return selected;
  if (alias.effect !== 'not-attempted') {
    await observeVersionAlias(verify, selected);
    return save({ ...selected, versionAlias: { ...alias, effect: 'accepted', verified: true } });
  }
  const adapter = versionAliasTransport(verify, true), assign = adapter.assign;
  if (!assign || !selected.deploymentId) throw new ReleaseError('SOURCE_UNSUPPORTED');
  await admit(); await guard();
  let state = selected;
  if (!await bindingForCandidate(verify, state)) {
    state = await save({ ...state, versionAlias: { ...alias, effect: 'unknown', verified: false } });
    const id = state.deploymentId;
    if (!id) throw new ReleaseError('SLOT_STATE');
    const result = custom
      ? await request(signal => assign.call(adapter, id, alias.hostname, signal), verify.config.limits.requestMs, verify.signal)
      : await assign.call(adapter, id, alias.hostname, verify.signal ?? new AbortController().signal);
    const response = record(result);
    if (response.alias !== alias.hostname || typeof response.uid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(response.uid))
      throw new ReleaseError('VERCEL_API', { reason: 'VERSION_ALIAS_RESPONSE' });
    if (response.oldDeploymentId !== undefined && response.oldDeploymentId !== id) throw conflict('EXTERNAL_REBIND_REPORTED');
    state = await save({ ...state, versionAlias: { ...alias, effect: 'accepted', verified: false } });
  }
  await observeVersionAlias(verify, state);
  return save({ ...state, versionAlias: { ...alias, effect: 'accepted', verified: true } });
}
