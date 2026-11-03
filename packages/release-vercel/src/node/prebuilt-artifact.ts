import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PrebuiltReleaseState, ReleaseConfig } from '../contracts.js';
import { record, ReleaseError } from './errors.js';
import { assertPathChain, pathExists, readBoundedJson } from './managed-io.js';
import { configDigest } from './source.js';
import { artifactGuard, artifactInvalid, type ArtifactInventory } from './prebuilt-inventory.js';
import { applyArtifactDirectoryModes, artifactMarkerFile, inspectArtifact } from './prebuilt-scan.js';

export interface PrebuiltArtifact extends ArtifactInventory {
  readonly root: string; readonly uploadRoot: string; readonly sourceSha: string; readonly configSha256: string;
  readonly artifactSha256: string; readonly uploadIdentity: { readonly dev: string; readonly ino: string };
}
export const prebuiltMarkerPath = '/.well-known/forge-prebuilt.json';
export const prebuiltManifestLimit = 4_194_304;
const manifestLimit = prebuiltManifestLimit;
export function prebuiltArtifactPaths(cwd: string): { root: string; uploadRoot: string; manifestPath: string } {
  const uploadRoot = resolve(cwd, '.tmp/forge-vercel-release/prebuilt');
  return { root: resolve(cwd, '.vercel/output'), uploadRoot, manifestPath: resolve(uploadRoot, '.vercel/forge-artifact.json') };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const artifactDigest = (sourceSha: string, configSha256: string, inventory: ArtifactInventory) =>
  digest(JSON.stringify({ formatVersion: 2, sourceSha, configSha256, ...inventory }));
const inventory = (artifact: ArtifactInventory): ArtifactInventory => ({ files: artifact.files,
  directories: artifact.directories, links: artifact.links, byteLength: artifact.byteLength });
function manifest(artifact: PrebuiltArtifact) {
  return { kind: 'forge-prebuilt-artifact', ...artifact.uploadIdentity, ...prebuiltMarker(artifact), formatVersion: 2, ...inventory(artifact) };
}
export function prebuiltMarker(artifact: Pick<PrebuiltArtifact, 'sourceSha' | 'configSha256' | 'artifactSha256'>): Record<string, unknown> {
  return { schemaVersion: 1, sourceSha: artifact.sourceSha, configSha256: artifact.configSha256, artifactSha256: artifact.artifactSha256 };
}
export function matchesPrebuiltMarker(value: unknown, artifact: Pick<PrebuiltArtifact, 'sourceSha' | 'configSha256' | 'artifactSha256'>): boolean {
  const input = record(value), expected = prebuiltMarker(artifact);
  return Object.keys(input).length === Object.keys(expected).length && Object.entries(expected).every(([key, field]) => input[key] === field);
}
export async function freezePrebuiltArtifact(cwd: string, config: ReleaseConfig, sourceSha: string, signal: AbortSignal | undefined,
  reserve: (bytes: number) => Promise<void>): Promise<PrebuiltArtifact> {
  const deadline = Date.now() + config.limits.commandMs, { root, uploadRoot } = prebuiltArtifactPaths(cwd);
  await assertPathChain(cwd, root);
  const initial = await inspectArtifact(root, config, signal, deadline);
  const configuration = initial.files.find(file => file.path === 'config.json');
  if (!configuration || configuration.byteLength > manifestLimit) return artifactInvalid('BUILD_OUTPUT_CONFIG');
  const bytes = await readFile(resolve(root, 'config.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== configuration.sha256) artifactInvalid('FILE_CHANGED');
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { artifactInvalid('BUILD_OUTPUT_CONFIG'); }
  if (record(parsed).version !== 3) artifactInvalid('BUILD_OUTPUT_VERSION');
  const configSha256 = await configDigest(config), artifactSha256 = artifactDigest(sourceSha, configSha256, initial);
  artifactGuard(signal, deadline);
  await reserve(initial.byteLength + Buffer.byteLength(JSON.stringify(initial)) + 65_536);
  artifactGuard(signal, deadline);
  await assertPathChain(cwd, uploadRoot);
  if (await pathExists(uploadRoot)) {
    const ownerPath = resolve(uploadRoot, '.vercel/forge-artifact.json'); await assertPathChain(uploadRoot, ownerPath);
    const owner = record(await readBoundedJson(ownerPath, manifestLimit)), identity = await lstat(uploadRoot, { bigint: true });
    artifactGuard(signal, deadline);
    if (owner.kind !== 'forge-prebuilt-artifact' || owner.dev !== String(identity.dev) || owner.ino !== String(identity.ino)) artifactInvalid('UPLOAD_ROOT_FOREIGN');
    await rm(uploadRoot, { recursive: true });
  }
  artifactGuard(signal, deadline);
  const destination = resolve(uploadRoot, '.vercel/output'); await mkdir(destination, { recursive: true });
  const identity = await lstat(uploadRoot, { bigint: true }), uploadIdentity = { dev: String(identity.dev), ino: String(identity.ino) };
  await writeFile(resolve(uploadRoot, '.vercel/forge-artifact.json'), JSON.stringify({ kind: 'forge-prebuilt-artifact', ...uploadIdentity }), { flag: 'wx' });
  const copied = await inspectArtifact(root, config, signal, deadline, destination);
  if (JSON.stringify(copied) !== JSON.stringify(initial)) throw new ReleaseError('ARTIFACT_CHANGED');
  const artifact: PrebuiltArtifact = { root, uploadRoot, sourceSha, configSha256, artifactSha256, uploadIdentity, ...initial };
  const sealed = JSON.stringify(manifest(artifact)); if (Buffer.byteLength(sealed) > manifestLimit) artifactInvalid('MANIFEST_LIMIT');
  await writeFile(resolve(uploadRoot, '.vercel/forge-artifact.json'), sealed);
  await writeFile(resolve(uploadRoot, '.vercel/project.json'), JSON.stringify({ projectId: config.vercel.projectId, orgId: config.vercel.teamId }), { flag: 'wx' });
  const marker = resolve(destination, artifactMarkerFile); await assertPathChain(destination, dirname(marker));
  await mkdir(dirname(marker), { recursive: true }); await assertPathChain(destination, dirname(marker));
  await writeFile(marker, JSON.stringify(prebuiltMarker(artifact)), { flag: 'wx' });
  await applyArtifactDirectoryModes(destination, initial.directories, signal, deadline);
  await assertPrebuiltArtifact(artifact, config, signal, deadline);
  return artifact;
}
export async function assertPrebuiltArtifact(artifact: PrebuiltArtifact, config: ReleaseConfig, signal?: AbortSignal,
  deadline = Date.now() + config.limits.commandMs): Promise<void> {
  try {
    const expectedDirectories = new Set(artifact.directories.map(item => item.path));
    const generated = new Set(['static', 'static/.well-known'].filter(path => !expectedDirectories.has(path)));
    const current = await inspectArtifact(artifact.root, config, signal, deadline);
    const uploaded = await inspectArtifact(resolve(artifact.uploadRoot, '.vercel/output'), config, signal, deadline, undefined, generated);
    if (artifactDigest(artifact.sourceSha, await configDigest(config), current) !== artifact.artifactSha256
      || JSON.stringify(current) !== JSON.stringify(uploaded)) throw new ReleaseError('ARTIFACT_CHANGED');
    const identity = await lstat(artifact.uploadRoot, { bigint: true });
    if (String(identity.dev) !== artifact.uploadIdentity.dev || String(identity.ino) !== artifact.uploadIdentity.ino
      || JSON.stringify((await readdir(artifact.uploadRoot)).sort()) !== '[".vercel"]'
      || JSON.stringify((await readdir(resolve(artifact.uploadRoot, '.vercel'))).sort()) !== '["forge-artifact.json","output","project.json"]') throw new ReleaseError('ARTIFACT_CHANGED');
    for (const [path, expected, limit] of [
      ['.vercel/forge-artifact.json', manifest(artifact), manifestLimit],
      ['.vercel/project.json', { projectId: config.vercel.projectId, orgId: config.vercel.teamId }, 4096],
      [`.vercel/output/${artifactMarkerFile}`, prebuiltMarker(artifact), 4096],
    ] as const) {
      const absolute = resolve(artifact.uploadRoot, path); await assertPathChain(artifact.uploadRoot, absolute);
      const value = await readBoundedJson(absolute, limit); artifactGuard(signal, deadline);
      if (JSON.stringify(value) !== JSON.stringify(expected)) throw new ReleaseError('ARTIFACT_CHANGED');
    }
    artifactGuard(signal, deadline);
  } catch (error) {
    if (error instanceof ReleaseError && ['CANCELLED', 'BUDGET_EXCEEDED'].includes(error.code)) throw error;
    throw new ReleaseError('ARTIFACT_CHANGED');
  }
}

/** 只读复核原封存输出及身份；恢复不得重新构建、复制或生成 marker 来补造原输入。 */
export async function assertRecordedPrebuiltArtifact(cwd: string, config: ReleaseConfig, state: PrebuiltReleaseState, signal?: AbortSignal): Promise<void> {
  try {
    const deadline = Date.now() + config.limits.commandMs;
    const { root, uploadRoot } = prebuiltArtifactPaths(cwd);
    await assertPathChain(cwd, root); await assertPathChain(cwd, uploadRoot);
    const ownerPath = resolve(uploadRoot, '.vercel/forge-artifact.json'); await assertPathChain(uploadRoot, ownerPath);
    const owner = record(await readBoundedJson(ownerPath, manifestLimit));
    if (typeof owner.dev !== 'string' || !/^\d+$/u.test(owner.dev) || typeof owner.ino !== 'string' || !/^\d+$/u.test(owner.ino)) throw new ReleaseError('ARTIFACT_CHANGED');
    const current = await inspectArtifact(root, config, signal, deadline);
    const artifact: PrebuiltArtifact = { ...current, root, uploadRoot, sourceSha: state.sourceSha, configSha256: state.configSha256,
      artifactSha256: state.artifactSha256, uploadIdentity: { dev: owner.dev, ino: owner.ino } };
    await assertPrebuiltArtifact(artifact, config, signal, deadline);
  } catch (error) {
    if (error instanceof ReleaseError && ['CANCELLED', 'BUDGET_EXCEEDED'].includes(error.code)) throw error;
    throw new ReleaseError('ARTIFACT_CHANGED');
  }
}
