import type { PrebuiltReleaseState, ReleaseDeployment } from '../contracts.js';
import type { ExecutionContext } from './release-context.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { vercelInvocation } from './execution.js';
import { assertPrebuiltArtifact, freezePrebuiltArtifact } from './prebuilt-artifact.js';
import { candidateId, candidateOrigin, createPrebuiltTransport, PrebuiltVerification } from './prebuilt-vercel.js';
import { observePrebuiltCandidate } from './prebuilt-recovery.js';
import { request } from './vercel.js';
import { configDigest } from './source.js';
import { versionAliasBuildEnvironment, versionAliasCandidateEnvironment, versionAliasOrigin } from './version-alias.js';
import { assertVersionAliasAvailable, bindVersionAlias, observeVersionAlias, versionAliasTransport } from './prebuilt-alias.js';
import { createPrebuiltCliContext } from './prebuilt-cli-context.js';

export async function publishPrebuiltCandidate(context: ExecutionContext, command: 'check' | 'publish' | 'status' | 'verify'): Promise<ReleaseDeployment | undefined> {
  const { execution, config, sha, signal, effects, prebuilt } = context;
  if (!prebuilt || config.source.mode !== 'managed-commit' || !config.delivery) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'PREBUILT_MANAGED_CONTEXT_REQUIRED' });
  const delivery = config.delivery;
  assertActive(signal);
  const selected = prebuilt.state;
  const save = async (value: PrebuiltReleaseState) => {
    const copied = structuredClone(value);
    effects.deploymentCreate = value.createEffect; effects.deploymentPromote = value.promoteEffect;
    if (value.versionAlias) effects.versionAliasAssign = value.versionAlias.effect;
    await prebuilt.save(copied); return copied;
  };
  if (selected?.createEffect === 'unknown' && !selected.deploymentId) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_CREATE_UNKNOWN' });
  if (command === 'publish' && selected?.versionAlias && (selected.versionAlias.effect === 'unknown'
    || (selected.versionAlias.effect === 'accepted' && !selected.versionAlias.verified)))
    throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'VERSION_ALIAS_UNRESOLVED' });
  if (command === 'status' || command === 'verify') {
    const found = await observePrebuiltCandidate(config, selected, context.transport ?? createPrebuiltTransport(execution, config, false), signal);
    if (command === 'verify') {
      await save(found.observed);
      await context.stage('acceptance');
      for (const [index, check] of config.acceptance.entries()) await execution.run(`acceptance:${index}`, check, 'ACCEPTANCE_FAILED', {
        FORGE_RELEASE_COMMAND: command, FORGE_RELEASE_SHA: sha,
        FORGE_RELEASE_URL: versionAliasOrigin(config, sha) ?? found.deployment.url,
        FORGE_RELEASE_DEPLOYMENT_ID: found.deployment.id, FORGE_RELEASE_ARTIFACT_SHA256: found.observed.artifactSha256,
        ...versionAliasCandidateEnvironment(config, found.observed) });
      await context.assertFrozen();
    }
    return found.deployment;
  }
  const values = { FORGE_RELEASE_COMMAND: command, FORGE_RELEASE_SHA: sha,
    ...versionAliasBuildEnvironment(config, sha, config.delivery.versionAlias ? await configDigest(config) : '') };
  await context.stage('checks');
  for (const [index, check] of config.checks.entries()) await execution.run(`check:${index}`, check, 'CHECK_FAILED', values);
  await context.assertFrozen(); await context.stage('artifact');
  const artifact = await freezePrebuiltArtifact(execution.cwd, config, sha, signal, bytes => prebuilt.reserve(bytes));
  const versionOrigin = versionAliasOrigin(config, sha);
  const initial: PrebuiltReleaseState = { sourceSha: sha, configSha256: artifact.configSha256, artifactSha256: artifact.artifactSha256,
    fileCount: artifact.files.length + artifact.links.length, byteLength: artifact.byteLength, createEffect: 'not-attempted', promoteEffect: 'not-attempted', acceptanceVerified: false, promotionVerified: false,
    ...(versionOrigin ? { versionAlias: { hostname: new URL(versionOrigin).hostname, effect: 'not-attempted', verified: false } } : {}) };
  if (selected && (selected.sourceSha !== sha || selected.configSha256 !== artifact.configSha256 || selected.artifactSha256 !== artifact.artifactSha256)) {
    throw new ReleaseError('ARTIFACT_CHANGED', { reason: 'RECORDED_CANDIDATE_CHANGED' });
  }
  let state = selected ?? await save(initial);
  if (command === 'check') return;
  const verify = new PrebuiltVerification(config, context.transport ?? createPrebuiltTransport(execution, config, true), signal);
  const promote = verify.transport.promote?.bind(verify.transport);
  if (!promote) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'PREBUILT_PROMOTION_TRANSPORT_REQUIRED' });
  const guard = async () => { assertActive(signal); await context.assertFrozen(); await assertPrebuiltArtifact(artifact, config, signal); await context.mutationGuard(); await verify.project(); };
  const admission = async (phase: 'create' | 'version-alias' | 'promote') => {
    await context.stage('admission');
    for (const [index, check] of delivery.admission.entries()) await execution.run(`admission:${phase}:${index}`, check, 'ADMISSION_FAILED',
      { ...values, FORGE_RELEASE_PHASE: phase, FORGE_RELEASE_ARTIFACT_SHA256: artifact.artifactSha256,
        FORGE_RELEASE_SERIALIZATION_SCOPE: delivery.concurrencyControl.scope,
        FORGE_RELEASE_PROJECT_ID: config.vercel.projectId, FORGE_RELEASE_TEAM_ID: config.vercel.teamId,
        ...(state?.deploymentId ? { FORGE_RELEASE_DEPLOYMENT_ID: state.deploymentId } : {}) });
  };
  if (!state.deploymentId) {
    if (state.versionAlias) {
      versionAliasTransport(verify, true); await guard(); await context.stage('version-alias');
      await assertVersionAliasAvailable(verify, state.versionAlias.hostname);
    }
    await admission('create'); await guard(); await context.stage('deployment');
    const cli = await createPrebuiltCliContext(execution.cwd, config.vercel.teamId, signal);
    let creationError: unknown, creationFailed = false;
    try {
      assertActive(signal); state = await save({ ...state, createEffect: 'unknown' });
      const invocation = vercelInvocation(['--global-config', cli.directory, 'deploy', '--prebuilt', '--archive=tgz', '--prod', '--skip-domain', '--no-wait', '--json', '--non-interactive',
        '--project', config.vercel.projectId, '--scope', config.vercel.teamId], { preserveArchiveModes: true });
      const output = await prebuilt.executionAt(artifact.uploadRoot).run('prebuilt-create', invocation, 'VERCEL_API', cli.environment, signal, false);
      let parsed: unknown; try { parsed = JSON.parse(output); } catch { throw new ReleaseError('VERCEL_API', { reason: 'INVALID_CREATE_JSON' }); }
      const envelope = record(parsed), candidate = record(envelope.deployment ?? parsed);
      if ((envelope.status !== undefined && envelope.status !== 'ok') || candidate.target !== 'production') throw new ReleaseError('DEPLOYMENT_SOURCE');
      state = await save({ ...state, deploymentId: candidateId(candidate.id), deploymentUrl: candidateOrigin(candidate.url), createEffect: 'accepted' });
    } catch (error) { creationFailed = true; creationError = error; }
    try { await cli.dispose(); }
    catch (cleanup) {
      if (creationError instanceof ReleaseError) throw new ReleaseError(creationError.code, { ...creationError.details, cleanup: 'CLI_CONTEXT_CLEANUP' });
      if (creationFailed) throw new AggregateError([creationError, cleanup], 'CLI_CONTEXT_CLEANUP', { cause: cleanup });
      throw cleanup;
    }
    if (creationFailed) throw creationError;
  }
  const candidate = await verify.ready(state);
  if (state.promoteEffect !== 'not-attempted') {
    try { await observeVersionAlias(verify, state); await verify.alias(state); await save({ ...state, promoteEffect: 'accepted', promotionVerified: true }); return candidate; }
    catch (error) {
      assertActive(signal); if (error instanceof ReleaseError && error.code === 'VERSION_ALIAS_CONFLICT') throw error;
      throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_PROMOTION_UNRESOLVED', deploymentId: state.deploymentId });
    }
  }
  if (state.versionAlias) {
    state = await bindVersionAlias(verify, state, save, guard, async () => {
      await admission('version-alias'); await context.stage('version-alias');
    }, context.transport !== undefined);
  }
  await context.stage('acceptance');
  for (const [index, check] of config.acceptance.entries()) await execution.run(`acceptance:${index}`, check, 'ACCEPTANCE_FAILED',
    { ...values, FORGE_RELEASE_URL: versionOrigin ?? candidate.url, FORGE_RELEASE_DEPLOYMENT_ID: candidate.id,
      FORGE_RELEASE_ARTIFACT_SHA256: artifact.artifactSha256, ...versionAliasCandidateEnvironment(config, state) });
  state = await save({ ...state, acceptanceVerified: true });
  await admission('promote'); await guard(); await verify.ready(state); await context.stage('promote');
  await observeVersionAlias(verify, state);
  state = await save({ ...state, promoteEffect: 'unknown' });
  // 不调用会自动重试 POST 的 CLI promote；公开 transport 必须仅提交一次提升请求。
  if (context.transport) await request(requestSignal => promote(candidate.id, requestSignal), config.limits.requestMs, signal);
  else await promote(candidate.id, signal ?? new AbortController().signal);
  state = await save({ ...state, promoteEffect: 'accepted' });
  await verify.waitAlias(state); await observeVersionAlias(verify, state); await save({ ...state, promotionVerified: true });
  return candidate;
}
