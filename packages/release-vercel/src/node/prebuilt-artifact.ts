import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ReleaseConfig } from '../contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { assertPathChain, pathExists } from './managed-io.js';
import { configDigest } from './source.js';

export interface PrebuiltArtifactFile { readonly path: string; readonly sha256: string; readonly byteLength: number; readonly mode: number }
export interface PrebuiltArtifact {
  readonly root: string; readonly uploadRoot: string; readonly sourceSha: string; readonly configSha256: string;
  readonly artifactSha256: string; readonly files: readonly PrebuiltArtifactFile[]; readonly byteLength: number;
}
export const prebuiltMarkerPath = '/.well-known/forge-prebuilt.json';
const markerFile = 'static/.well-known/forge-prebuilt.json', manifestLimit = 4_194_304;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = (reason: string): never => { throw new ReleaseError('ARTIFACT_INVALID', { reason }); };
function guard(signal: AbortSignal | undefined, deadline: number): void {
  assertActive(signal); if (Date.now() >= deadline) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'ARTIFACT_DEADLINE' });
}
function portable(path: string): void {
  if (Buffer.byteLength(path) > 1024 || path.split('/').some(part => !part || part === '.' || part === '..'
    || Buffer.byteLength(part) > 255 || /[<>:"\\|?*]/u.test(part) || [...part].some(value => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127) || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    || /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519)$/iu.test(part))) invalid('UNSAFE_PATH');
}
async function inspect(root: string, config: ReleaseConfig, signal: AbortSignal | undefined, deadline: number,
  destination?: string, generatedMarker = false): Promise<{ files: PrebuiltArtifactFile[]; byteLength: number }> {
  if (!config.delivery) return invalid('DELIVERY_REQUIRED');
  const limits = config.delivery;
  const files: PrebuiltArtifactFile[] = [], names = new Set<string>(); let byteLength = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    guard(signal, deadline); await assertPathChain(root, directory);
    const before = await lstat(directory, { bigint: true }); if (!before.isDirectory() || before.isSymbolicLink()) invalid('LINK_OR_DIRECTORY');
    const entries: string[] = [];
    for await (const entry of await opendir(directory)) {
      guard(signal, deadline); if (entries.length + names.size >= limits.maxFiles * 2 + 64) invalid('ENTRY_LIMIT');
      entries.push(entry.name);
    }
    for (const entry of entries.sort()) {
      const path = `${prefix}${entry}`; portable(path);
      if (path === markerFile) { if (generatedMarker) continue; invalid('RESERVED_MARKER'); }
      const key = path.normalize('NFC').toLowerCase(); if (names.has(key)) invalid('CASE_COLLISION'); names.add(key);
      const absolute = resolve(root, path); await assertPathChain(root, absolute);
      const stat = await lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) invalid('LINK_OR_DIRECTORY');
      if (stat.isDirectory()) { await visit(absolute, `${path}/`); continue; }
      if (!stat.isFile() || stat.size > BigInt(limits.maxBytes - byteLength) || files.length >= limits.maxFiles) invalid('ARTIFACT_LIMIT');
      const handle = await open(absolute, 'r'); let output: Awaited<ReturnType<typeof open>> | undefined;
      const hash = createHash('sha256'); let length = 0;
      try {
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) invalid('FILE_REPLACED');
        if (destination) { const target = resolve(destination, path); await mkdir(dirname(target), { recursive: true }); output = await open(target, 'wx', Number(stat.mode & 0o777n)); }
        const buffer = Buffer.alloc(65_536);
        while (true) {
          guard(signal, deadline); const part = await handle.read(buffer); if (part.bytesRead === 0) break;
          length += part.bytesRead; if (length > Number(stat.size)) invalid('FILE_CHANGED');
          const bytes = buffer.subarray(0, part.bytesRead); hash.update(bytes);
          if (output) { let offset = 0; while (offset < bytes.length) {
            guard(signal, deadline); const written = (await output.write(bytes, offset)).bytesWritten;
            if (written === 0) invalid('INCOMPLETE_WRITE'); offset += written;
          } }
        }
        const after = await handle.stat({ bigint: true }), current = await lstat(absolute, { bigint: true });
        if (length !== Number(stat.size) || after.mtimeNs !== stat.mtimeNs || after.size !== stat.size
          || current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeNs !== stat.mtimeNs) invalid('FILE_CHANGED');
        // open 的 mode 仍受 umask 影响；显式恢复摘要中记录的 POSIX 权限。
        if (output && process.platform !== 'win32') await output.chmod(Number(stat.mode & 0o777n));
      } finally { await output?.close(); await handle.close(); }
      byteLength += length; files.push({ path, sha256: hash.digest('hex'), byteLength: length, mode: Number(stat.mode & 0o777n) });
    }
    const after = await lstat(directory, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs) invalid('DIRECTORY_CHANGED');
  }
  try { await visit(root, ''); } catch (error) {
    if (error instanceof ReleaseError && error.code !== 'SLOT_PATH') throw error;
    throw new ReleaseError('ARTIFACT_INVALID', { reason: 'ARTIFACT_READ' });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { files, byteLength };
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
  const deadline = Date.now() + config.limits.commandMs, root = resolve(cwd, '.vercel/output');
  await assertPathChain(cwd, root);
  const initial = await inspect(root, config, signal, deadline);
  const configuration = initial.files.find(file => file.path === 'config.json');
  if (!configuration || configuration.byteLength > manifestLimit) return invalid('BUILD_OUTPUT_CONFIG');
  const bytes = await readFile(resolve(root, 'config.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== configuration.sha256) invalid('FILE_CHANGED');
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid('BUILD_OUTPUT_CONFIG'); }
  if (record(parsed).version !== 3) invalid('BUILD_OUTPUT_VERSION');
  const configSha256 = await configDigest(config), artifactSha256 = digest(JSON.stringify({ sourceSha, configSha256, files: initial.files }));
  await reserve(initial.byteLength + Buffer.byteLength(JSON.stringify(initial.files)) + 65_536);
  const uploadRoot = resolve(cwd, '.tmp/forge-vercel-release/prebuilt'); await assertPathChain(cwd, uploadRoot);
  if (await pathExists(uploadRoot)) {
    const ownerPath = resolve(uploadRoot, '.vercel/forge-artifact.json'); await assertPathChain(uploadRoot, ownerPath);
    const ownerStat = await lstat(ownerPath); if (!ownerStat.isFile() || ownerStat.size > manifestLimit) invalid('UPLOAD_ROOT_FOREIGN');
    const owner = record(JSON.parse(await readFile(ownerPath, 'utf8'))), identity = await lstat(uploadRoot, { bigint: true });
    if (owner.kind !== 'forge-prebuilt-artifact' || owner.dev !== String(identity.dev) || owner.ino !== String(identity.ino)) invalid('UPLOAD_ROOT_FOREIGN');
    await rm(uploadRoot, { recursive: true });
  }
  await mkdir(resolve(uploadRoot, '.vercel/output'), { recursive: true });
  const identity = await lstat(uploadRoot, { bigint: true });
  const owner = { kind: 'forge-prebuilt-artifact', dev: String(identity.dev), ino: String(identity.ino) };
  const ownerPath = resolve(uploadRoot, '.vercel/forge-artifact.json'); await writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx' });
  const copied = await inspect(root, config, signal, deadline, resolve(uploadRoot, '.vercel/output'));
  if (JSON.stringify(copied) !== JSON.stringify(initial)) throw new ReleaseError('ARTIFACT_CHANGED');
  const artifact: PrebuiltArtifact = { root, uploadRoot, sourceSha, configSha256, artifactSha256, ...initial };
  const manifest = JSON.stringify({ ...owner, ...prebuiltMarker(artifact), files: initial.files });
  if (Buffer.byteLength(manifest) > manifestLimit) invalid('MANIFEST_LIMIT');
  await writeFile(ownerPath, manifest);
  await writeFile(resolve(uploadRoot, '.vercel/project.json'), JSON.stringify({ projectId: config.vercel.projectId, orgId: config.vercel.teamId }), { flag: 'wx' });
  const marker = resolve(uploadRoot, `.vercel/output/${markerFile}`); await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify(prebuiltMarker(artifact)), { flag: 'wx' });
  return artifact;
}
export async function assertPrebuiltArtifact(artifact: PrebuiltArtifact, config: ReleaseConfig, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + config.limits.commandMs;
  try {
    const current = await inspect(artifact.root, config, signal, deadline);
    const uploaded = await inspect(resolve(artifact.uploadRoot, '.vercel/output'), config, signal, deadline, undefined, true);
    if (digest(JSON.stringify({ sourceSha: artifact.sourceSha, configSha256: await configDigest(config), files: current.files })) !== artifact.artifactSha256
      || JSON.stringify(current) !== JSON.stringify(uploaded)) throw new ReleaseError('ARTIFACT_CHANGED');
    if (JSON.stringify((await readdir(artifact.uploadRoot)).sort()) !== '[".vercel"]'
      || JSON.stringify((await readdir(resolve(artifact.uploadRoot, '.vercel'))).sort()) !== '["forge-artifact.json","output","project.json"]') throw new ReleaseError('ARTIFACT_CHANGED');
    for (const [path, expected] of [
      ['.vercel/project.json', { projectId: config.vercel.projectId, orgId: config.vercel.teamId }],
      [`.vercel/output/${markerFile}`, prebuiltMarker(artifact)],
    ] as const) {
      const absolute = resolve(artifact.uploadRoot, path); await assertPathChain(artifact.uploadRoot, absolute);
      if ((await lstat(absolute)).size > 4096 || JSON.stringify(JSON.parse(await readFile(absolute, 'utf8'))) !== JSON.stringify(expected)) throw new ReleaseError('ARTIFACT_CHANGED');
    }
  } catch (error) {
    if (error instanceof ReleaseError && ['CANCELLED', 'BUDGET_EXCEEDED'].includes(error.code)) throw error;
    throw new ReleaseError('ARTIFACT_CHANGED');
  }
}
