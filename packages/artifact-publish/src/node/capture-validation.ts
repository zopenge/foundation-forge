import { constants } from 'node:buffer';
import { isAbsolute, resolve } from 'node:path';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { OperationBudget } from '../budget.js';
import { ArtifactPublicationError } from '../errors.js';
import type { ArtifactCaptureFile, ArtifactCaptureSource, ArtifactFileCaptureOptions } from './capture-contracts.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (code: 'INVALID_SOURCE' | 'INVALID_PLAN' | 'INVALID_OPTIONS'): never => { throw new ArtifactPublicationError(code); };
const fields = (value: Record<string, unknown>, keys: readonly string[]) => {
  let count = 0;
  for (const key in value) if (Object.hasOwn(value, key)) {
    if (++count > keys.length || !keys.includes(key)) return false;
  }
  return count === keys.length;
};

export function capturePath(path: unknown): string {
  if (typeof path !== 'string' || new TextEncoder().encode(path).byteLength > 1024
    || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return invalid('INVALID_SOURCE');
  try { return validatePortableRelativePath(path); } catch { return invalid('INVALID_SOURCE'); }
}

/** 同时检查文件/祖先冲突和大小写不同的共同目录，不能仅对完整路径去重。 */
export function assertCapturePaths(paths: readonly string[], sensitivity: string, code: 'INVALID_SOURCE' | 'INVALID_PLAN'): void {
  const files = new Set<string>(), names = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const name = parts.slice(0, index).join('/'), key = sensitivity === 'case-insensitive' ? name.toLowerCase() : name;
      if ((names.has(key) && names.get(key) !== name) || files.has(key)
        || (index === parts.length && names.has(key))) return invalid(code);
      names.set(key, name);
    }
    files.add(sensitivity === 'case-insensitive' ? path.toLowerCase() : path);
  }
}

export function validateCaptureLimits(input: ArtifactFileCaptureOptions): void {
  if (!record(input) || !['case-sensitive', 'case-insensitive'].includes(input.pathCaseSensitivity)) return invalid('INVALID_OPTIONS');
  const bounds = ['maxFiles', 'maxEntries', 'maxFileBytes', 'maxTotalBytes', 'maxManifestBytes', 'timeoutMilliseconds'] as const;
  for (const key of bounds) if (!Number.isSafeInteger(input[key]) || input[key] <= 0) return invalid('INVALID_OPTIONS');
  if (input.maxFiles > 10_000 || input.maxManifestBytes > 1_048_576 || input.maxFileBytes >= constants.MAX_LENGTH
    || input.timeoutMilliseconds > 2_147_483_647 || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) return invalid('INVALID_OPTIONS');
}

export function snapshotCaptureOptions(input: ArtifactFileCaptureOptions, budget: OperationBudget): ArtifactFileCaptureOptions {
  budget.assertActive();
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > input.maxFiles) return invalid('INVALID_PLAN');
  let count = 0, policyBytes = 0;
  const roots = new Set<string>(), logicalPaths: string[] = [];
  const sources = Array.from(input.sources, (source): ArtifactCaptureSource => {
    budget.assertActive();
    if (!record(source) || !fields(source, ['rootDirectory', 'closure', 'files']) || typeof source.rootDirectory !== 'string'
      || !isAbsolute(source.rootDirectory) || (source.closure !== 'exact' && source.closure !== 'declared')) return invalid('INVALID_SOURCE');
    const rootDirectory = resolve(source.rootDirectory), rootKey = input.pathCaseSensitivity === 'case-insensitive' ? rootDirectory.toLowerCase() : rootDirectory;
    if (roots.has(rootKey)) return invalid('INVALID_SOURCE');
    roots.add(rootKey);
    if (!Array.isArray(source.files) || source.files.length < 1 || (count += source.files.length) > input.maxFiles) return invalid('INVALID_PLAN');
    const files = Array.from(source.files, (file): ArtifactCaptureFile => {
      budget.assertActive();
      if (!record(file) || (file.role !== 'asset' && file.role !== 'control')
        || !fields(file, ['sourcePath', 'path', 'role', ...(file.role === 'asset' ? ['responseHeaders'] : [])])) return invalid('INVALID_PLAN');
      const sourcePath = capturePath(file.sourcePath), path = capturePath(file.path);
      budget.assertActive();
      logicalPaths.push(path);
      if (file.role === 'control') return { sourcePath, path, role: 'control' };
      if (!record(file.responseHeaders)) return invalid('INVALID_PLAN');
      const entries: [string, string][] = [];
      for (const key in file.responseHeaders) if (Object.hasOwn(file.responseHeaders, key)) {
        budget.assertActive();
        const value = file.responseHeaders[key];
        if (typeof value !== 'string' || key.length > 256 || value.length > 2048) return invalid('INVALID_PLAN');
        policyBytes += new TextEncoder().encode(key + value).byteLength;
        if (policyBytes > input.maxManifestBytes) throw new ArtifactPublicationError('BUDGET_EXCEEDED');
        entries.push([key, value]);
      }
      return { sourcePath, path, role: 'asset', responseHeaders: Object.fromEntries(entries) };
    });
    assertCapturePaths(files.map(file => file.sourcePath), input.pathCaseSensitivity, 'INVALID_SOURCE');
    return { rootDirectory, closure: source.closure, files };
  });
  assertCapturePaths(logicalPaths, input.pathCaseSensitivity, 'INVALID_PLAN');
  budget.assertActive();
  return { ...input, sources };
}
