import type { Corpus, Entity, EntityEnvelope, SearchRequest } from './contracts.js';
import { validateCorpus } from './validate.js';

const normalizeText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US');
const queryTokens = (value: string): readonly string[] => normalizeText(value)
  .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
  .split(/[^\p{L}\p{N}]+/u)
  .filter((item) => item.length > 0);

const inScope = (entity: Entity, scope: readonly string[] | undefined): boolean => {
  if (!scope || scope.length === 0) return true;
  return scope.some((prefix) => entity.source.path.startsWith(prefix) || entity.id.startsWith(prefix));
};

const lexicalScore = (entity: Entity, tokens: readonly string[]): number => {
  const haystack = normalizeText([
    entity.name, entity.owner ?? '', entity.signature ?? '', entity.source.path,
  ].join(' '));
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
};

const makeCursor = (request: SearchRequest, corpus: Corpus, offset: number): string => {
  const payload = {
    corpusId: corpus.corpusId, generationId: corpus.generationId, by: request.by,
    value: request.value, scope: [...(request.scope ?? [])], offset,
  };
  return `v1:${encodeURIComponent(JSON.stringify(payload))}`;
};
const readCursor = (request: SearchRequest, corpus: Corpus): number | null => {
  if (!request.cursor) return 0;
  if (!request.cursor.startsWith('v1:')) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(request.cursor.slice(3))) as {
      corpusId: string; generationId: string; by: string; value: string; scope: string[]; offset: number;
    };
    const expectedScope = [...(request.scope ?? [])];
    const matches = parsed.corpusId === corpus.corpusId && parsed.generationId === corpus.generationId
      && parsed.by === request.by && parsed.value === request.value
      && JSON.stringify(parsed.scope) === JSON.stringify(expectedScope)
      && Number.isInteger(parsed.offset) && parsed.offset >= 0;
    return matches ? parsed.offset : null;
  } catch {
    return null;
  }
};

const base = (corpus: Corpus, status: EntityEnvelope['status']): Omit<EntityEnvelope, 'entities'> => ({
  schemaVersion: 1,
  status,
  corpusId: corpus.corpusId,
  generationId: corpus.generationId,
  corpusState: corpus.corpusState,
  coverage: corpus.coverage,
  truncated: false,
  nextCursor: null,
  diagnostics: [],
});
export const searchEntities = (corpus: Corpus, request: SearchRequest): EntityEnvelope => {
  const validation = validateCorpus(corpus);
  if (validation.length > 0) return { ...base(corpus, 'error'), diagnostics: validation, entities: [] };
  const limit = request.limit ?? 5;
  if (!request.value || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ...base(corpus, 'error'), diagnostics: [{ code: 'INVALID_ARGUMENT', details: {} }], entities: [] };
  }
  const offset = readCursor(request, corpus);
  if (offset === null) {
    return { ...base(corpus, 'error'), diagnostics: [{ code: 'CURSOR_MISMATCH', details: {} }], entities: [] };
  }
  const scoped = corpus.entities.filter((entity) => inScope(entity, request.scope));
  const normalizedValue = normalizeText(request.value);
  const exact = scoped.filter((entity) => request.by === 'path'
    ? entity.kind !== 'symbol' && normalizeText(entity.source.path) === normalizedValue
    : request.by === 'symbol' ? normalizeText(entity.name) === normalizedValue : false);
  if (exact.length > 0) {
    const ordered = [...exact].sort((left, right) => left.id.localeCompare(right.id));
    const page = ordered.slice(offset, offset + limit);
    const hasMore = offset + page.length < ordered.length;
    return { ...base(corpus, ordered.length > 1 ? 'ambiguous' : 'ok'), entities: page,
      truncated: hasMore, nextCursor: hasMore ? makeCursor(request, corpus, offset + page.length) : null };
  }
  const tokens = queryTokens(request.value);
  const ranked = scoped
    .map((entity) => ({ entity, score: lexicalScore(entity, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || left.entity.source.path.localeCompare(right.entity.source.path)
      || left.entity.source.lineStart - right.entity.source.lineStart
      || left.entity.id.localeCompare(right.entity.id));
  const page = ranked.slice(offset, offset + limit).map((entry) => entry.entity);
  const hasMore = offset + page.length < ranked.length;
  return {
    ...base(corpus, page.length > 0 ? 'ok' : 'no-match'),
    entities: page,
    truncated: hasMore,
    nextCursor: hasMore ? makeCursor(request, corpus, offset + page.length) : null,
  };
};

export const describeEntities = (corpus: Corpus, ids: readonly string[]): EntityEnvelope => {
  const validation = validateCorpus(corpus);
  if (validation.length > 0) return { ...base(corpus, 'error'), diagnostics: validation, entities: [] };
  const requested = new Set(ids);
  const entities = corpus.entities.filter((entity) => requested.has(entity.id));
  return { ...base(corpus, entities.length > 0 ? 'ok' : 'no-match'), entities };
};
