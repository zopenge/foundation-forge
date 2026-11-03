import { createHash } from 'node:crypto';
import { realpath as realpathForNode } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, readlink, realpath, symlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReleaseConfig } from '../contracts.js';
import { ReleaseError } from './errors.js';
import { assertPathChain } from './managed-io.js';
import { artifactGuard, artifactInvalid, artifactLinkTarget, artifactPath,
  type ArtifactDirectory, type ArtifactFile, type ArtifactInventory, type ArtifactLinkInput } from './prebuilt-inventory.js';
import { resolveArtifactLinks } from './prebuilt-links.js';

export const artifactMarkerFile = 'static/.well-known/forge-prebuilt.json';
const nodeRealpath = promisify(realpathForNode);
export async function inspectArtifact(root: string, config: ReleaseConfig, signal: AbortSignal | undefined, deadline: number,
  destination?: string, generatedDirectories?: ReadonlySet<string>): Promise<ArtifactInventory> {
  if (!config.delivery) return artifactInvalid('DELIVERY_REQUIRED');
  const limits = config.delivery, files: ArtifactFile[] = [], directories: ArtifactDirectory[] = [], links: ArtifactLinkInput[] = [];
  const names = new Set<string>(); let byteLength = 0;
  const guard = () => artifactGuard(signal, deadline);
  async function visit(directory: string, prefix: string): Promise<void> {
    guard(); await assertPathChain(root, directory);
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return artifactInvalid('LINK_OR_DIRECTORY');
    if (prefix && !generatedDirectories?.has(prefix.slice(0, -1))) directories.push({ path: prefix.slice(0, -1), mode: Number(before.mode & 0o777n) });
    if (destination && prefix) await mkdir(resolve(destination, prefix), { recursive: true });
    const entries: string[] = [];
    for await (const entry of await opendir(directory)) {
      guard(); if (entries.length + names.size >= limits.maxFiles * 2 + 64) return artifactInvalid('ENTRY_LIMIT');
      entries.push(entry.name);
    }
    // 官方 tgz 仅枚举文件和链接；只有保留 marker 的父目录会由工具明确物化。
    if (!entries.length && prefix && prefix !== 'static/' && prefix !== 'static/.well-known/') return artifactInvalid('EMPTY_DIRECTORY');
    for (const entry of entries.sort()) {
      guard(); const path = `${prefix}${entry}`; artifactPath(path);
      if (path === artifactMarkerFile) { if (generatedDirectories) continue; return artifactInvalid('RESERVED_MARKER'); }
      const key = path.normalize('NFC').toLowerCase(); if (names.has(key)) return artifactInvalid('CASE_COLLISION'); names.add(key);
      const absolute = resolve(root, path); await assertPathChain(root, dirname(absolute));
      const stat = await lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        const raw = await readlink(absolute), target = artifactLinkTarget(raw), after = await lstat(absolute, { bigint: true });
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeNs !== stat.mtimeNs || await readlink(absolute) !== raw) return artifactInvalid('LINK_CHANGED');
        const bytes = Buffer.byteLength(target);
        if (files.length + links.length >= limits.maxFiles || bytes > limits.maxBytes - byteLength) return artifactInvalid('ARTIFACT_LIMIT');
        byteLength += bytes; links.push({ path, target, mode: Number(stat.mode & 0o777n) }); continue;
      }
      if (stat.isDirectory()) { await visit(absolute, `${path}/`); continue; }
      if (!stat.isFile() || stat.size > BigInt(limits.maxBytes - byteLength) || files.length + links.length >= limits.maxFiles) return artifactInvalid('ARTIFACT_LIMIT');
      const handle = await open(absolute, 'r'); let output: Awaited<ReturnType<typeof open>> | undefined;
      const hash = createHash('sha256'); let length = 0;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) return artifactInvalid('FILE_REPLACED');
        if (destination) {
          const target = resolve(destination, path); await assertPathChain(destination, dirname(target));
          await mkdir(dirname(target), { recursive: true }); output = await open(target, 'wx', Number(stat.mode & 0o777n));
        }
        const buffer = Buffer.alloc(65_536);
        while (true) {
          guard(); const part = await handle.read(buffer); if (part.bytesRead === 0) break;
          length += part.bytesRead; if (length > Number(stat.size)) return artifactInvalid('FILE_CHANGED');
          const bytes = buffer.subarray(0, part.bytesRead); hash.update(bytes);
          if (output) { let offset = 0; while (offset < bytes.length) {
            guard(); const written = (await output.write(bytes, offset)).bytesWritten;
            if (!written) return artifactInvalid('INCOMPLETE_WRITE'); offset += written;
          } }
        }
        const after = await handle.stat({ bigint: true }), current = await lstat(absolute, { bigint: true });
        if (length !== Number(stat.size) || after.mtimeNs !== stat.mtimeNs || after.size !== stat.size
          || current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeNs !== stat.mtimeNs) return artifactInvalid('FILE_CHANGED');
        if (output && process.platform !== 'win32') await output.chmod(Number(stat.mode & 0o777n));
      } finally { await output?.close(); await handle.close(); }
      byteLength += length; files.push({ path, sha256: hash.digest('hex'), byteLength: length, mode: Number(stat.mode & 0o777n) });
    }
    const after = await lstat(directory, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs) return artifactInvalid('DIRECTORY_CHANGED');
  }
  try {
    await visit(root, '');
    const resolved = resolveArtifactLinks(files, directories, links, guard);
    const physicalRoot = await realpath(root);
    for (const link of resolved) {
      guard(); const absolute = resolve(root, link.path);
      // Node 模块使用的默认 realpath 与原生 realpath(3) 对链接前缀和 .. 可能有不同结果，必须同时一致。
      const [physicalTarget, runtimeTarget] = await Promise.all([realpath(absolute), nodeRealpath(absolute)]); guard();
      const portable = (path: string) => relative(physicalRoot, path).split(process.platform === 'win32' ? '\\' : '/').join('/');
      if (portable(physicalTarget) !== link.resolvedPath) return artifactInvalid('LINK_NATIVE_TARGET');
      if (portable(runtimeTarget) !== link.resolvedPath) return artifactInvalid('LINK_NODE_TARGET');
      if (artifactLinkTarget(await readlink(absolute)) !== link.target) return artifactInvalid('LINK_CHANGED');
    }
    if (destination) for (const link of resolved) {
      guard(); const target = resolve(destination, link.path); await assertPathChain(destination, dirname(target));
      await symlink(link.target, target, link.kind === 'directory' ? 'dir' : 'file');
    }
    const sorted = <T extends { path: string }>(items: T[]) => items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    guard();
    return { files: sorted(files), directories: sorted(directories), links: sorted(resolved), byteLength };
  } catch (error) {
    if (error instanceof ReleaseError && error.code !== 'SLOT_PATH') throw error;
    throw new ReleaseError('ARTIFACT_INVALID', { reason: 'ARTIFACT_READ' });
  }
}
export async function applyArtifactDirectoryModes(root: string, directories: readonly ArtifactDirectory[], signal: AbortSignal | undefined, deadline: number): Promise<void> {
  if (process.platform === 'win32') return;
  for (const directory of [...directories].sort((a, b) => b.path.length - a.path.length)) {
    artifactGuard(signal, deadline); const path = resolve(root, directory.path); await assertPathChain(root, path); await chmod(path, directory.mode);
  }
}
