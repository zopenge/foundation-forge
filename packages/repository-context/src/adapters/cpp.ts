import { createHash } from 'node:crypto';
import type { Diagnostic, Edge, Entity, SourceRef } from '../core/contracts.js';
import type { ExtractionResult } from './contracts.js';

export interface CppExtractionOptions {
  readonly path: string;
  readonly text: string;
  readonly corpusId: string;
  readonly generationId: string;
}

export interface CppExtractionResult extends ExtractionResult {
  readonly readiness: 'ready-for-lexical-evidence' | 'rejected';
  readonly configurationDigest: null;
}

const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const sourceRef = (
  options: CppExtractionOptions,
  sourceSha256: string,
  lineStart: number,
  lineEnd = lineStart,
): SourceRef => ({
  corpusId: options.corpusId,
  generationId: options.generationId,
  path: options.path.replaceAll('\\', '/'),
  sourceSha256,
  normalizedSha256: null,
  snapshotId: null,
  lineStart,
  lineEnd,
});

const symbolPatterns = [
  /\b(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_][A-Za-z0-9_]*)/u,
  /\bnamespace\s+([A-Za-z_][A-Za-z0-9_]*)/u,
  /\b(?:virtual\s+)?(?:[A-Za-z_][A-Za-z0-9_:<>,*&\s]+)\s+([A-Za-z_~][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:=\s*0\s*)?[;{]/u,
] as const;

export const extractCpp = (options: CppExtractionOptions): CppExtractionResult => {
  const portablePath = options.path.replaceAll('\\', '/');
  if (options.text.trim().length === 0) {
    return {
      readiness: 'rejected',
      entities: [],
      edges: [],
      diagnostics: [{ code: 'EMPTY_SOURCE', details: { path: portablePath } }],
      configurationDigest: null,
    };
  }
  const digest = sha256(options.text);
  const lines = options.text.split(/\r\n|\r|\n/u);
  const fileId = `file:${portablePath}`;
  const entities: Entity[] = [{
    id: fileId,
    kind: 'file',
    name: portablePath.split('/').at(-1) ?? portablePath,
    owner: null,
    signature: null,
    source: sourceRef(options, digest, 1, Math.max(1, lines.length)),
    evidenceLevel: 'literal-path',
  }];
  const edges: Edge[] = [];
  const names = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const include = line.match(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/u);
    if (include?.[1]) {
      edges.push({
        from: fileId,
        to: null,
        kind: 'includes',
        resolution: 'unresolved',
        evidence: sourceRef(options, digest, index + 1),
        evidenceLevel: 'lexical-hint',
        configurationDigest: null,
      });
    }
    for (const pattern of symbolPatterns) {
      const match = line.match(pattern);
      const name = match?.[1];
      if (!name || names.has(`${name}:${index + 1}`)) continue;
      names.add(`${name}:${index + 1}`);
      entities.push({
        id: `symbol:${portablePath}:${name}:${index + 1}`,
        kind: 'symbol',
        name,
        owner: null,
        signature: line.trim().slice(0, 512),
        source: sourceRef(options, digest, index + 1),
        evidenceLevel: 'lexical-hint',
      });
      break;
    }
  }
  const diagnostics: Diagnostic[] = [];
  return {
    readiness: 'ready-for-lexical-evidence',
    entities,
    edges,
    diagnostics,
    configurationDigest: null,
  };
};
