import type { PrebuiltCandidateContext, PrebuiltReleaseState, ReleaseConfig, VersionAliasConfig } from '../contracts.js';
import { record, ReleaseError } from './errors.js';

/** 固定完整 SHA 占位，只接受能解析为单个 DNS 标签的显式版本主机名。 */
export function parseVersionAliasConfig(value: unknown): VersionAliasConfig {
  const entry = record(value), template = entry.hostnameTemplate;
  const match = typeof template === 'string' ? /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-\{sha\}\.vercel\.app$/u.exec(template) : null;
  const prefix = match?.[1];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(entry).length !== 1
    || !prefix || prefix.length > 22) throw new ReleaseError('CONFIG_INVALID', { field: 'delivery.versionAlias' });
  return { hostnameTemplate: String(template) };
}

export function versionAliasOrigin(config: ReleaseConfig, sha: string): string | undefined {
  if (!config.delivery?.versionAlias) return;
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new ReleaseError('CANDIDATE_CHANGED', { reason: 'VERSION_ALIAS_SHA' });
  const template = parseVersionAliasConfig(config.delivery.versionAlias).hostnameTemplate;
  const hostname = template.replace('{sha}', sha);
  let url: URL;
  try { url = new URL(`https://${hostname}`); } catch { throw new ReleaseError('CONFIG_INVALID', { field: 'delivery.versionAlias' }); }
  if (url.hostname !== hostname || hostname === new URL(config.vercel.productionUrl).hostname)
    throw new ReleaseError('CONFIG_INVALID', { field: 'delivery.versionAlias', reason: 'VERSION_ALIAS_HOSTNAME' });
  return url.origin;
}

export function versionAliasBuildEnvironment(config: ReleaseConfig, sha: string, configSha256: string): Readonly<Record<string, string>> {
  const origin = versionAliasOrigin(config, sha);
  return origin ? { FORGE_RELEASE_VERSION_URL: origin, FORGE_RELEASE_CONFIG_SHA256: configSha256,
    FORGE_RELEASE_CANDIDATE_CONTEXT: '' } : {};
}

/** 公开身份只包含冻结输入和确切候选，不包含凭据、完整配置或环境。 */
export function prebuiltCandidateContext(config: ReleaseConfig, state: PrebuiltReleaseState | undefined): PrebuiltCandidateContext | undefined {
  if (!state?.deploymentId || !state.deploymentUrl || !config.delivery?.versionAlias) return;
  const versionUrl = versionAliasOrigin(config, state.sourceSha);
  if (!versionUrl) return;
  return Object.freeze({ teamId: config.vercel.teamId, projectId: config.vercel.projectId,
    sourceSha: state.sourceSha, configSha256: state.configSha256, artifactSha256: state.artifactSha256,
    deploymentId: state.deploymentId, candidateUrl: state.deploymentUrl, versionUrl,
    versionAliasVerified: state.versionAlias?.verified === true });
}

export function versionAliasCandidateEnvironment(config: ReleaseConfig, state: PrebuiltReleaseState): Readonly<Record<string, string>> {
  const context = prebuiltCandidateContext(config, state);
  return context ? { ...versionAliasBuildEnvironment(config, state.sourceSha, state.configSha256),
    FORGE_RELEASE_CANDIDATE_CONTEXT: JSON.stringify(context) } : {};
}
