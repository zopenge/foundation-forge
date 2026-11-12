import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { ArtifactContentIdentity } from './content-identity.js';
import { ArtifactPublicationError } from './errors.js';

interface ContentFile {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type ArtifactContentManifestFile = ContentFile & (
  | { readonly role: 'asset'; readonly responseHeaders: Readonly<Record<string, string>> }
  | { readonly role: 'control' }
);
export interface ArtifactContentManifest {
  readonly schemaVersion: 1;
  readonly files: readonly ArtifactContentManifestFile[];
}
export interface PreparedArtifactContentManifest {
  readonly manifest: ArtifactContentManifest;
  readonly bytes: Uint8Array;
  readonly content: ArtifactContentIdentity;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const invalid = (): never => { throw new ArtifactPublicationError('INVALID_PLAN'); };

function headers(input: unknown): Readonly<Record<string, string>> {
  if (!record(input)) return invalid();
  const seen = new Set<string>();
  const entries = Object.entries(input).map(([key, value]) => {
    const name = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) || name.length > 256 || seen.has(name)
      || typeof value !== 'string' || !value || value.trim() !== value || value.length > 2048
      || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126)) return invalid();
    seen.add(name);
    return [name, value] as const;
  }).sort(([a], [b]) => compare(a, b));
  if (!seen.has('content-type') || !seen.has('cache-control')) return invalid();
  return Object.freeze(Object.fromEntries(entries));
}

function file(input: unknown): ArtifactContentManifestFile {
  if (!record(input) || typeof input.path !== 'string' || typeof input.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(input.sha256) || typeof input.byteLength !== 'number'
    || !Number.isSafeInteger(input.byteLength) || input.byteLength < 0
    || (input.role !== 'asset' && input.role !== 'control')) return invalid();
  const allowed = ['path', 'role', 'byteLength', 'sha256', ...(input.role === 'asset' ? ['responseHeaders'] : [])];
  if (Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key))
    || new TextEncoder().encode(input.path).byteLength > 1024
    || [...input.path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return invalid();
  const path = validatePortableRelativePath(input.path);
  const base = { path, role: input.role, byteLength: input.byteLength, sha256: input.sha256 };
  return input.role === 'asset'
    ? Object.freeze({ ...base, role: 'asset', responseHeaders: headers(input.responseHeaders) })
    : Object.freeze({ ...base, role: 'control' });
}

/** 规范化清单声明并计算真实清单字节摘要；不替调用方读取或认证负载。 */
export async function createArtifactContentManifest(input: ArtifactContentManifest): Promise<PreparedArtifactContentManifest> {
  let manifest: ArtifactContentManifest;
  try {
    if (!record(input) || input.schemaVersion !== 1 || Object.keys(input).length !== 2
      || Object.keys(input).some(key => key !== 'schemaVersion' && key !== 'files')
      || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 10_000) return invalid();
    const files = Array.from(input.files, file).sort((a, b) => compare(a.path, b.path));
    const paths = new Set<string>();
    let byteLength = 0;
    for (const item of files) {
      byteLength += item.byteLength;
      if (paths.has(item.path) || !Number.isSafeInteger(byteLength)) return invalid();
      paths.add(item.path);
    }
    manifest = Object.freeze({ schemaVersion: 1, files: Object.freeze(files) });
  } catch { return invalid(); }
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.byteLength > 1_048_576) return invalid();
  const { sha256 } = await calculateBytesIntegrity(bytes);
  return Object.freeze({ manifest, bytes, content: Object.freeze({ manifestSha256: sha256 }) });
}
