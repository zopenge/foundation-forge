import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import { generatedArtifactErrorCodes as codes, type GeneratedArtifactPlan, type GeneratedArtifactSnapshotEntry } from '../contracts.js';
import { GeneratedArtifactError } from '../errors.js';
import { defineGeneratedArtifactPlan } from '../plan.js';
import type { GeneratedArtifactFilesystemOptions } from './contracts.js';

export const systemErrorCode = (error: unknown): string | undefined => error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

export function prepareOperation(rootDirectory: string, input: GeneratedArtifactPlan, options: GeneratedArtifactFilesystemOptions): { root: string; plan: GeneratedArtifactPlan } {
  if (!isAbsolute(rootDirectory)) throw new GeneratedArtifactError(codes.rootNotAbsolute, { rootDirectory });
  const plan = defineGeneratedArtifactPlan(input);
  if (options?.pathCaseSensitivity !== 'case-sensitive' && options?.pathCaseSensitivity !== 'case-insensitive') throw new GeneratedArtifactError(codes.invalidOptions, { option: 'pathCaseSensitivity' });
  const root = resolve(rootDirectory);
  const paths = [...plan.artifacts.map(item => item.path), ...plan.retiredPaths];
  const folded = new Map<string, string>();
  for (const path of paths) {
    const key = options.pathCaseSensitivity === 'case-insensitive' ? path.toLowerCase() : path;
    const previous = folded.get(key);
    if (previous !== undefined) throw new GeneratedArtifactError(codes.caseCollision, { path, previous });
    folded.set(key, path);
    targetPath(root, path);
  }
  for (const [key, path] of folded) {
    let separator = key.indexOf('/');
    while (separator !== -1) {
      const ancestor = folded.get(key.slice(0, separator));
      if (ancestor !== undefined) throw new GeneratedArtifactError(codes.pathConflict, { path, ancestor, reason: 'file-ancestor' });
      separator = key.indexOf('/', separator + 1);
    }
  }
  return { root, plan };
}

export function targetPath(root: string, path: string): string {
  try { return resolvePathWithinRoot(root, path); }
  catch (cause) { throw new GeneratedArtifactError(codes.targetOutsideRoot, { path }, cause); }
}

function ancestors(path: string): string[] {
  const volume = parse(path).root;
  const parts = path.slice(volume.length).split(sep).filter(Boolean);
  const result = [volume];
  let current = volume;
  for (const part of parts) { current = resolve(current, part); result.push(current); }
  return result;
}

export async function assertSafePath(target: string, logicalPath: string, directory = false): Promise<void> {
  for (const current of ancestors(target)) {
    let metadata;
    try { metadata = await lstat(current); }
    catch (cause) {
      if (systemErrorCode(cause) === 'ENOENT') continue;
      throw new GeneratedArtifactError(codes.readFailed, { path: logicalPath, operation: 'lstat', systemCode: systemErrorCode(cause) }, cause);
    }
    if (metadata.isSymbolicLink()) throw new GeneratedArtifactError(codes.symlinkRejected, { path: logicalPath });
    const isDirectory = current !== target || directory;
    if (isDirectory && !metadata.isDirectory()) throw new GeneratedArtifactError(codes.readFailed, { path: logicalPath, operation: 'ancestor-not-directory' });
    if (!isDirectory && metadata.isDirectory()) throw new GeneratedArtifactError(codes.targetIsDirectory, { path: logicalPath });
    if (!isDirectory && !metadata.isFile()) throw new GeneratedArtifactError(codes.readFailed, { path: logicalPath, operation: 'target-not-regular-file' });
  }
}

export async function ensureParentDirectories(target: string, logicalPath: string): Promise<void> {
  for (const directory of ancestors(dirname(target))) {
    await assertSafePath(directory, logicalPath, true);
    let exists = true;
    try { await lstat(directory); }
    catch (cause) { if (systemErrorCode(cause) === 'ENOENT') exists = false; else throw cause; }
    if (!exists) {
      try { await mkdir(directory); }
      catch (cause) { if (systemErrorCode(cause) !== 'EEXIST') throw cause; }
    }
    await assertSafePath(directory, logicalPath, true);
  }
}

export async function readSafeArtifact(root: string, path: string): Promise<Uint8Array | undefined> {
  const target = targetPath(root, path);
  await assertSafePath(target, path);
  let handle;
  let content: Uint8Array | undefined;
  let failure: GeneratedArtifactError | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertSafePath(target, path);
    const [opened, current] = await Promise.all([handle.stat(), lstat(target)]);
    if (opened.dev !== current.dev || opened.ino !== current.ino || !opened.isFile()) throw new GeneratedArtifactError(codes.readFailed, { path, operation: 'target-changed' });
    content = await handle.readFile();
  } catch (cause) {
    if (systemErrorCode(cause) !== 'ENOENT') {
      failure = cause instanceof GeneratedArtifactError ? cause : new GeneratedArtifactError(codes.readFailed, { path, operation: 'read', systemCode: systemErrorCode(cause) }, cause);
    }
  } finally {
    try { await handle?.close(); }
    catch (cause) { failure ??= new GeneratedArtifactError(codes.readFailed, { path, operation: 'close', systemCode: systemErrorCode(cause) }, cause); }
  }
  if (failure !== undefined) throw failure;
  return content;
}

export async function snapshotPlan(root: string, plan: GeneratedArtifactPlan): Promise<GeneratedArtifactSnapshotEntry[]> {
  await assertSafePath(root, '', true);
  const result: GeneratedArtifactSnapshotEntry[] = [];
  for (const path of [...plan.artifacts.map(item => item.path), ...plan.retiredPaths]) {
    const content = await readSafeArtifact(root, path);
    if (content !== undefined) result.push({ path, content });
  }
  return result;
}
