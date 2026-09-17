import type { SnapshotManifest } from './contracts.js';
import type { ProvenanceCapture, ProvenanceFileState, ProvenanceProducer } from './snapshot-provenance-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { catalogHash, catalogJson } from './read-catalog-codec.js';
import { parseSourceTextDetails } from './text-format.js';
export const provenanceMismatch = (field: string): never => { throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field }); };
export const provenanceInvalid = (field: string): never => { throw new SourceSnapshotError('INVALID_INPUT', { field }); };
export const provenanceDigest = (value: string, field: string): string => /^[a-f0-9]{64}$/u.test(value) ? value : provenanceInvalid(field);
export const provenanceProducer = (value: ProvenanceProducer | undefined): ProvenanceProducer | null => {
  if (value === undefined) return null;
  if (value === null || typeof value.id !== 'string' || typeof value.version !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.id) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.version)) provenanceInvalid('producer');
  return Object.freeze({ id: value.id, version: value.version,
    ...(value.configDigest === undefined ? {} : { configDigest: provenanceDigest(value.configDigest, 'configDigest') }) });
};
export const provenanceGroupsDigest = (manifest: SnapshotManifest): Promise<string> =>
  catalogHash(catalogJson(manifest.files.map(file => ({ path: file.path, group: parseSourceTextDetails(file.details).group }))));
export const provenanceStates = (manifest: SnapshotManifest, capture: ProvenanceCapture): readonly ProvenanceFileState[] => {
  if (capture.fileStates.length !== manifest.files.length) provenanceMismatch('file-state-count');
  const states = new Map<string, ProvenanceFileState>();
  for (const file of capture.fileStates) {
    if (states.has(file.path)) provenanceMismatch('duplicate-file-state');
    if (typeof file.tracked !== 'boolean' || typeof file.untracked !== 'boolean' || file.tracked === file.untracked ||
      !/^[ MADRCUT?!]$/u.test(file.indexStatus) || !/^[ MADRCUT?!]$/u.test(file.worktreeStatus)) provenanceInvalid('file-state');
    const staged = file.tracked && file.indexStatus !== ' ' && file.indexStatus !== '?';
    const worktreeModified = file.tracked && file.worktreeStatus !== ' ' && file.worktreeStatus !== '?';
    if (staged !== file.staged || worktreeModified !== file.worktreeModified) provenanceMismatch('file-state-flags');
    states.set(file.path, Object.freeze({ path: file.path, sha256: file.sha256, tracked: file.tracked, untracked: file.untracked,
      staged, worktreeModified, indexStatus: file.indexStatus, worktreeStatus: file.worktreeStatus }));
  }
  return Object.freeze(manifest.files.map(file => {
    const state = states.get(file.path);
    if (state === undefined || state.sha256 !== file.sha256) return provenanceMismatch('file-state-source');
    return state;
  }));
};
