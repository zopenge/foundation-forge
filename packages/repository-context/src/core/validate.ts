import type { Corpus, Diagnostic, SourceRef } from './contracts.js';

const sha256Pattern = /^[a-f0-9]{64}$/u;

const validateSource = (source: SourceRef, corpus: Corpus): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (source.corpusId !== corpus.corpusId || source.generationId !== corpus.generationId) {
    diagnostics.push({ code: 'SOURCE_BINDING_MISMATCH', details: { path: source.path } });
  }
  if (!source.path || source.path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(source.path) || source.path.split(/[\\/]/u).includes('..')) {
    diagnostics.push({ code: 'UNSAFE_PATH', details: { path: source.path } });
  }
  if (!sha256Pattern.test(source.sourceSha256)) {
    diagnostics.push({ code: 'INVALID_SOURCE_DIGEST', details: { path: source.path } });
  }
  if (!Number.isInteger(source.lineStart) || !Number.isInteger(source.lineEnd) || source.lineStart < 1 || source.lineEnd < source.lineStart) {
    diagnostics.push({ code: 'INVALID_RANGE', details: { path: source.path, lineStart: source.lineStart, lineEnd: source.lineEnd } });
  }
  return diagnostics;
};

export const validateCorpus = (corpus: Corpus): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<string>();
  for (const entity of corpus.entities) {
    if (ids.has(entity.id)) diagnostics.push({ code: 'DUPLICATE_ENTITY_ID', details: { id: entity.id } });
    ids.add(entity.id);
    diagnostics.push(...validateSource(entity.source, corpus));
  }
  for (const edge of corpus.edges) {
    diagnostics.push(...validateSource(edge.evidence, corpus));
    if (!ids.has(edge.from)) diagnostics.push({ code: 'UNKNOWN_EDGE_SOURCE', details: { from: edge.from } });
    if (edge.to !== null && edge.resolution === 'resolved' && !ids.has(edge.to)) {
      diagnostics.push({ code: 'UNKNOWN_EDGE_TARGET', details: { to: edge.to } });
    }
    if (edge.resolution === 'unresolved' && edge.to !== null) {
      diagnostics.push({ code: 'UNRESOLVED_EDGE_HAS_TARGET', details: { from: edge.from, to: edge.to } });
    }
  }
  return diagnostics;
};
