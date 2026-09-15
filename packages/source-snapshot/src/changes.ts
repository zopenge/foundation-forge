import type { SnapshotFileChanges, SnapshotManifest } from './contracts.js';
import { SourceSnapshotError } from './errors.js';
import { compareStrings } from './validation.js';
export const compareSnapshotFiles = (previous: SnapshotManifest | null, current: SnapshotManifest): SnapshotFileChanges => {
  if (previous !== null && previous.projectId !== current.projectId) throw new SourceSnapshotError('PROJECT_MISMATCH');
  const old = new Map(previous?.files.map(value => [value.path, value]) ?? []);
  const now = new Map(current.files.map(value => [value.path, value]));
  return {
    added: [...now.keys()].filter(value => !old.has(value)).sort(compareStrings),
    changed: [...now.values()].filter(value => old.has(value.path) && (old.get(value.path)?.sha256 !== value.sha256 || old.get(value.path)?.byteLength !== value.byteLength)).map(value => value.path).sort(compareStrings),
    removed: [...old.keys()].filter(value => !now.has(value)).sort(compareStrings),
  };
};
