import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { sortJsonValue, stringifyDeterministicJson, type JsonValue } from '@openge/forge-deterministic-json';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SnapshotManifest, SnapshotManifestInput } from './contracts.js';
import { SourceSnapshotError } from './errors.js';
import { assertArray, assertCount, assertProject, compareStrings, normalizeObject, objectPath, uniquePaths } from './validation.js';

const freezeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeJson(nested)])));
  }
  return value;
};

export const createSnapshotManifest = async (input: SnapshotManifestInput): Promise<SnapshotManifest> => {
  assertProject(input.projectId); assertCount(input.publishedAt, 'publishedAt');
  if (typeof input.policyVersion !== 'string' || input.policyVersion.length === 0) throw new SourceSnapshotError('INVALID_INPUT', { field: 'policyVersion' });
  assertArray(input.objects, 'objects'); assertArray(input.files, 'files'); assertArray(input.repositories, 'repositories');
  const objects = input.objects.map(value => { objectPath(value.path); return normalizeObject(value); }).sort((a, b) => compareStrings(a.path, b.path));
  uniquePaths(objects.map(value => value.path));
  const objectPaths = new Set(objects.map(value => value.path));
  const files = input.files.map(value => {
    const base = normalizeObject(value); uniquePaths(value.objectPaths);
    if (value.objectPaths.length === 0 || value.objectPaths.some(name => !objectPaths.has(name))) throw new SourceSnapshotError('DANGLING_OBJECT', { path: value.path });
    const details = value.details === undefined ? undefined : freezeJson(sortJsonValue(value.details));
    return Object.freeze({ ...base, objectPaths: Object.freeze([...value.objectPaths]), ...(details === undefined ? {} : { details }) });
  }).sort((a, b) => compareStrings(a.path, b.path));
  uniquePaths(files.map(value => value.path));
  const repositoryPaths = new Set<string>();
  const repositories = input.repositories.map(value => {
    if (value.path !== '') validatePortableRelativePath(value.path);
    if (repositoryPaths.has(value.path.toLowerCase())) throw new SourceSnapshotError('DUPLICATE_PATH', { path: value.path });
    repositoryPaths.add(value.path.toLowerCase());
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.head) || typeof value.dirty !== 'boolean' || (value.branch !== null && typeof value.branch !== 'string')) throw new SourceSnapshotError('INVALID_INPUT', { field: 'repository', path: value.path });
    return Object.freeze({ path: value.path, head: value.head, branch: value.branch, dirty: value.dirty });
  }).sort((a, b) => compareStrings(a.path, b.path));
  const identity = {
    schemaVersion: 1, projectId: input.projectId, policyVersion: input.policyVersion,
    repositories: repositories.map(value => ({ ...value })),
    files: files.map(value => ({ path: value.path, sha256: value.sha256, byteLength: value.byteLength, objectPaths: [...value.objectPaths], ...(value.details === undefined ? {} : { details: value.details }) })),
    objects: objects.map(value => ({ ...value })),
  };
  const publishedAt = input.publishedAt;
  const digest = await calculateBytesIntegrity(new TextEncoder().encode(stringifyDeterministicJson(identity)));
  return Object.freeze({ schemaVersion: 1, snapshotId: `snapshot-${digest.sha256}`, projectId: identity.projectId, policyVersion: identity.policyVersion, publishedAt, repositories: Object.freeze(repositories), files: Object.freeze(files), objects: Object.freeze(objects) });
};
