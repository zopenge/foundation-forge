import type { Corpus, Entity, EntityEnvelope, SearchRequest } from './contracts.js';
import { pathInScope } from './scope.js';
import { normalizeSearchText, tokenize } from './tokenize.js';
import { validateCorpus } from './validate.js';

const inScope = (entity: Entity, scope: readonly string[] | undefined): boolean => {
  if (!scope || scope.length === 0) return true;
  return scope.some((prefix) => pathInScope(entity.source.path, prefix));
};

const lexicalScore = (entity: Entity, query: string, tokens: readonly string[]): number => {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedName = normalizeSearchText(entity.name);
  const normalizedPath = normalizeSearchText(entity.source.path);
  const haystackTokens = new Set(tokenize([
    entity.name, entity.owner ?? '', entity.signature ?? '', entity.source.path,
  ].join(' ')));
  const exactName = normalizedName === normalizedQuery ? 100 : 0;
  const exactPath = normalizedPath === normalizedQuery ? 80 : 0;
  const tokenScore = tokens.reduce((score, token) => score + (haystackTokens.has(token) ? 4 : 0), 0);
  return exactName + exactPath + tokenScore;
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
  const normalizedValue = normalizeSearchText(request.value);
  const exact = scoped.filter((entity) => request.by === 'path'
    ? entity.kind !== 'symbol' && normalizeSearchText(entity.source.path) === normalizedValue
    : request.by === 'symbol' ? normalizeSearchText(entity.name) === normalizedValue : false);
  if (exact.length > 0) {
    const ordered = [...exact].sort((left, right) => left.id.localeCompare(right.id));
    const page = ordered.slice(offset, offset + limit);
    const hasMore = offset + page.length < ordered.length;
    return { ...base(corpus, ordered.length > 1 ? 'ambiguous' : 'ok'), entities: page,
      truncated: hasMore, nextCursor: hasMore ? makeCursor(request, corpus, offset + page.length) : null };
  }
  const tokens = tokenize(request.value);
  const ranked = scoped
    .map((entity) => ({ entity, score: lexicalScore(entity, request.value, tokens) }))
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
