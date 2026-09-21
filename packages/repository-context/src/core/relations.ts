import type { Corpus, Edge, EdgeEnvelope, RelationRequest } from './contracts.js';
import { validateCorpus } from './validate.js';

const base = (corpus: Corpus, status: EdgeEnvelope['status']): Omit<EdgeEnvelope, 'edges'> => ({
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

const edgeKey = (edge: Edge): string => [edge.from, edge.to ?? '', edge.kind, edge.evidence.path,
  String(edge.evidence.lineStart)].join('|');

export const queryRelations = (corpus: Corpus, request: RelationRequest): EdgeEnvelope => {
  const validation = validateCorpus(corpus);
  if (validation.length > 0) return { ...base(corpus, 'error'), diagnostics: validation, edges: [] };
  if (request.ids.length === 0 || (request.depth !== 1 && request.depth !== 2)) {
    return { ...base(corpus, 'error'), diagnostics: [{ code: 'INVALID_ARGUMENT', details: {} }], edges: [] };
  }
  const knownIds = new Set(corpus.entities.map((entity) => entity.id));
  if (request.ids.some((id) => !knownIds.has(id))) return { ...base(corpus, 'no-match'), edges: [] };

  let frontier = new Set(request.ids);
  const visited = new Set(request.ids);
  const collected = new Map<string, Edge>();
  for (let level = 0; level < request.depth && frontier.size > 0; level += 1) {
    const next = new Set<string>();
    for (const edge of corpus.edges) {
      const outgoing = (request.direction === 'out' || request.direction === 'both') && frontier.has(edge.from);
      const incoming = (request.direction === 'in' || request.direction === 'both') && edge.to !== null && frontier.has(edge.to);
      if (!outgoing && !incoming) continue;
      collected.set(edgeKey(edge), edge);
      if (outgoing && edge.to !== null && !visited.has(edge.to)) next.add(edge.to);
      if (incoming && !visited.has(edge.from)) next.add(edge.from);
    }
    for (const id of next) visited.add(id);
    frontier = next;
  }
  const edges = [...collected.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
  return { ...base(corpus, edges.length > 0 ? 'ok' : 'no-match'), edges };
};
