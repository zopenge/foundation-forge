import type { PreparedArtifactContentManifest } from '../content-manifest.js';
import { ArtifactPublicationError } from '../errors.js';
import type { CapturedArtifactFiles } from './capture-contracts.js';

export function capturedSnapshot(prepared: PreparedArtifactContentManifest, files: ReadonlyMap<string, Uint8Array>, payloadByteLength: number): CapturedArtifactFiles {
  return Object.freeze({
    manifest: prepared.manifest, content: prepared.content, payloadByteLength,
    get manifestBytes() { return Uint8Array.from(prepared.bytes); },
    readFile(path: string) {
      const bytes = files.get(path);
      if (!bytes) throw new ArtifactPublicationError('INVALID_SOURCE');
      return Uint8Array.from(bytes);
    },
  });
}
