import type { Edge, Entity } from '../core/contracts.js';
import { queryRelations } from '../core/relations.js';
import { searchEntities } from '../core/search.js';
import type {
  InvestigationCandidate,
  InvestigationEvidence,
  InvestigationRelation,
  InvestigationResult,
  RepositoryInvestigator,
  RepositoryInvestigatorOptions,
  ScopeCoverage,
} from './contracts.js';
import { queryAnchorSequences, queryTokens, scopeNamespaceTokens } from './query.js';
import { bestSymbolMatch } from './ranking.js';
import { bestRecoveryHint, bestWindow, type LoadedSource, type RankedWindow } from './windows.js';

const compactCandidate = (entity: Entity): InvestigationCandidate => ({
  id: entity.id,
  kind: entity.kind,
  name: entity.name,
  path: entity.source.path,
  lineStart: entity.source.lineStart,
  lineEnd: entity.source.lineEnd,
  ...(entity.signature ? { signature: entity.signature } : {}),
  evidenceLevel: entity.evidenceLevel,
});

const compactRelation = (edge: Edge, pathById: ReadonlyMap<string, string>): InvestigationRelation => ({
  from: edge.from,
  to: edge.to,
  fromPath: pathById.get(edge.from) ?? null,
  toPath: edge.to === null ? null : pathById.get(edge.to) ?? null,
  kind: edge.kind,
  resolution: edge.resolution,
  path: edge.evidence.path,
  lineStart: edge.evidence.lineStart,
  lineEnd: edge.evidence.lineEnd,
  evidenceLevel: edge.evidenceLevel,
});

const coverage = (entities: readonly Readonly<{ source: Readonly<{ path: string }> }>[], scopes: readonly string[]): ScopeCoverage => ({
  covered: scopes.filter((scope) => entities.some((entity) => entity.source.path.startsWith(scope))),
  missing: scopes.filter((scope) => !entities.some((entity) => entity.source.path.startsWith(scope))),
});

const appendUnique = (target: Entity[], entities: readonly Entity[], limit: number): void => {
  const ids = new Set(target.map((entity) => entity.id));
  for (const entity of entities) {
    if (target.length >= limit) break;
    if (!ids.has(entity.id)) {
      target.push(entity);
      ids.add(entity.id);
    }
  }
};

const asEvidence = (window: RankedWindow): InvestigationEvidence => ({ ...window });

const createSourceHintFinder = ({
  corpus,
  readRanges,
  preferredScopes,
  sourceHintLines,
}: Readonly<{
  corpus: RepositoryInvestigatorOptions['corpus'];
  readRanges: RepositoryInvestigatorOptions['readRanges'];
  preferredScopes: readonly string[];
  sourceHintLines: number;
}>) => {
  let cached: readonly LoadedSource[] | null = null;
  const load = async (): Promise<readonly LoadedSource[]> => {
    if (cached !== null) return cached;
    const files = corpus.entities.filter((entity) => entity.kind === 'file'
      && preferredScopes.some((scope) => entity.source.path.startsWith(scope)));
    if (files.length === 0) {
      cached = [];
      return cached;
    }
    const read = await readRanges(files.map((entity) => entity.source));
    cached = read.texts.map((item) => ({ source: item.source, path: item.path, text: item.text }));
    return cached;
  };
  return async (
    query: string,
    candidateEntities: readonly Entity[] = [],
    restrictedPaths: readonly string[] | null = null,
  ): Promise<readonly InvestigationEvidence[]> => {
    const tokens = queryTokens(query);
    if (tokens.length === 0 || preferredScopes.length === 0) return [];
    const anchors = queryAnchorSequences(query);
    const loaded = await load();
    const restricted = new Set(restrictedPaths ?? []);
    const files = restricted.size > 0 ? loaded.filter((item) => restricted.has(item.path)) : loaded;
    const preferred = new Set(candidateEntities.map((entity) => entity.source.path));
    const hints: RankedWindow[] = [];
    for (const scope of preferredScopes) {
      const namespace = scopeNamespaceTokens(scope);
      const filtered = tokens.filter((token) => !namespace.has(token));
      const rankingTokens = filtered.length > 0 ? filtered : tokens;
      const ranked = files.filter((item) => item.path.startsWith(scope)).map((item) => {
        const preferredEntity = candidateEntities.find((entity) => entity.kind === 'symbol' && entity.source.path === item.path);
        const match = bestSymbolMatch(corpus.entities, item.path, rankingTokens, tokens, namespace)
          ?? (preferredEntity ? { entity: preferredEntity, score: 1 } : null);
        const window = bestWindow(item.text, rankingTokens, sourceHintLines, match, anchors);
        const fileTokens: readonly string[] = item.path.split('/').at(-1)?.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
        const rolePathScore = rankingTokens.some((token) => token === 'decode') && fileTokens.includes('decode') ? 16 : 0;
        const pathScore = rolePathScore
          + rankingTokens.reduce((score, token) => score + (item.path.toLowerCase().includes(token) ? 1 : 0), 0);
        return { item, window, score: window.score + pathScore + (match?.score ?? 0)
          + (preferred.has(item.path) ? 0 : 0) };
      }).filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.item.path.localeCompare(right.item.path));
      const best = ranked[0];
      if (!best) {
        const explicitlyRequested = files.find((item) => item.path === scope);
        if (!explicitlyRequested) continue;
        const lines = explicitlyRequested.text.split('\n');
        const lineEnd = Math.min(sourceHintLines, lines.length);
        hints.push({
          source: { ...explicitlyRequested.source, lineStart: 1, lineEnd },
          path: explicitlyRequested.path,
          lineStart: 1,
          lineEnd,
          text: lines.slice(0, lineEnd).join('\n'),
          score: 0,
        });
        continue;
      }
      const lineStart = best.window.start + 1;
      const lineEnd = best.window.start + best.window.count;
      hints.push({
        source: { ...best.item.source, lineStart, lineEnd },
        path: best.item.path,
        lineStart,
        lineEnd,
        text: best.window.text,
        score: best.score,
      });
      const localRecovery = bestRecoveryHint(
        [best.item],
        query,
        rankingTokens,
        sourceHintLines,
        { path: best.item.path, lineStart, lineEnd },
      );
      if (localRecovery?.score !== undefined && localRecovery.score >= 20) {
        hints.push(localRecovery);
        const localFile = files.find((item) => item.path === best.item.path);
        const secondaryLocal = localFile === undefined ? null : bestRecoveryHint(
          [localFile], query, rankingTokens, sourceHintLines,
          { path: localRecovery.path, lineStart: localRecovery.lineStart, lineEnd: localRecovery.lineEnd },
        );
        if (secondaryLocal?.score !== undefined && secondaryLocal.score >= 20
          && !(secondaryLocal.lineStart <= lineEnd && secondaryLocal.lineEnd >= lineStart)) hints.push(secondaryLocal);
      }
      const recovery = bestRecoveryHint(
        files.filter((item) => item.path.startsWith(scope)),
        query,
        rankingTokens,
        sourceHintLines,
        { path: best.item.path, lineStart, lineEnd },
      );
      if (recovery?.score !== undefined && recovery.score >= 20
        && (localRecovery === null || recovery.path !== localRecovery.path || recovery.lineStart !== localRecovery.lineStart)) {
        hints.push(recovery);
        const recoveryFile = files.find((item) => item.path === recovery.path);
        const secondaryRecovery = recoveryFile === undefined ? null : bestRecoveryHint(
          [recoveryFile], query, rankingTokens, sourceHintLines,
          { path: recovery.path, lineStart: recovery.lineStart, lineEnd: recovery.lineEnd },
        );
        if (secondaryRecovery?.score !== undefined && secondaryRecovery.score >= 20) hints.push(secondaryRecovery);
      }
    }
    return hints.map(asEvidence);
  };
};

export const createRepositoryInvestigator = (options: RepositoryInvestigatorOptions): RepositoryInvestigator => {
  const maxCandidates = Math.max(1, Math.min(5, options.limits?.maxCandidates ?? 3));
  const evidenceLines = Math.max(1, Math.min(80, options.limits?.evidenceLines ?? 24));
  const sourceHintLines = Math.max(1, Math.min(12, options.limits?.sourceHintLines ?? 10));
  const preferredScopes = options.preferredScopes ?? [];
  const findSourceHints = createSourceHintFinder({
    corpus: options.corpus,
    readRanges: options.readRanges,
    preferredScopes,
    sourceHintLines,
  });
  const pathById = new Map(options.corpus.entities.map((entity) => [entity.id, entity.source.path]));
  const fileIdByPath = new Map(options.corpus.entities.filter((entity) => entity.kind === 'file')
    .map((entity) => [entity.source.path, entity.id]));

  return {
    investigate: async ({ query, scope }): Promise<InvestigationResult> => {
      if (query.trim().length === 0) {
        return {
          status: 'error', reason: 'INVALID_ARGUMENT', candidates: [], relations: [], evidence: [], sourceHints: [],
          primaryScopeCoverage: coverage([], preferredScopes),
          diagnostics: [{ code: 'INVALID_ARGUMENT', details: { field: 'query' } }],
        };
      }
      let found;
      const activePreferred = scope === undefined ? preferredScopes : preferredScopes.filter((prefix) => scope.some(
        (requested) => prefix.startsWith(requested) || requested.startsWith(prefix),
      ));
      if (options.route === 'investigate-relations' && activePreferred.length > 1) {
        const balanced: Entity[] = [];
        let truncated = activePreferred.length > maxCandidates;
        for (const prefix of activePreferred) {
          const scoped = searchEntities(options.corpus, { by: 'text', value: query, scope: [prefix], limit: 1 });
          if (scoped.truncated) truncated = true;
          appendUnique(balanced, scoped.entities, maxCandidates);
        }
        found = balanced.length > 0
          ? { status: 'ok' as const, entities: balanced, truncated }
          : { status: 'no-match' as const, entities: [], truncated: false };
      } else {
        const effectiveScope = scope ?? (preferredScopes.length > 0 ? preferredScopes : undefined);
        found = searchEntities(options.corpus, {
          by: 'text',
          value: query,
          ...(effectiveScope === undefined ? {} : { scope: effectiveScope }),
          limit: maxCandidates,
        });
      }
      if (scope === undefined && preferredScopes.length > 0 && (found.status === 'no-match' || found.entities.length === 0)) {
        found = searchEntities(options.corpus, { by: 'text', value: query, limit: maxCandidates });
      }
      const entities = found.entities.slice(0, maxCandidates);
      const relationSeedIds = options.route === 'investigate-relations'
        ? options.promoteRelationEndpoints === true
          ? [...entities.map((entity) => entity.id), ...new Set(entities.map((entity) => fileIdByPath.get(entity.source.path))
            .filter((id): id is string => id !== undefined))]
          : entities.map((entity) => entity.id)
        : [];
      const relationEdges = options.route === 'investigate-relations'
        ? queryRelations(options.corpus, { ids: relationSeedIds, direction: 'both', depth: 1 }).edges
          .filter((edge) => edge.resolution === 'resolved')
        : [];
      const relations = relationEdges.map((edge) => compactRelation(edge, pathById));
      const candidatePaths = new Set(entities.map((entity) => entity.source.path));
      const relationEndpointPaths = options.promoteRelationEndpoints === true
        ? [...new Set(relationEdges.flatMap((edge) => [pathById.get(edge.from), edge.to === null ? undefined : pathById.get(edge.to)])
          .filter((path): path is string => typeof path === 'string' && !candidatePaths.has(path)
            && preferredScopes.some((prefix) => path.startsWith(prefix))))]
        : [];
      const baseSourceHints = await findSourceHints(query, found.entities);
      const relationSourceHints = relationEndpointPaths.length > 0 ? await findSourceHints(query, [], relationEndpointPaths) : [];
      const sourceHints = options.route === 'investigate-relations' && options.promoteRelationEndpoints === true
        ? [...relationSourceHints, ...baseSourceHints]
          .filter((item, index, all) => all.findIndex((row) => row.path === item.path) === index)
          .slice(0, maxCandidates)
        : baseSourceHints;
      if ((found.status === 'no-match' || found.entities.length === 0) && sourceHints.length === 0) {
        return {
          status: 'insufficient', reason: 'NO_USEFUL_CANDIDATE', candidates: [], relations: [], evidence: [], sourceHints: [],
          primaryScopeCoverage: coverage([], preferredScopes), diagnostics: [],
        };
      }
      const evidenceEntities = entities.filter((entity, index, all) => (
        all.findIndex((candidate) => candidate.source.path === entity.source.path) === index
      ));
      const ranges = evidenceEntities.map((entity) => ({
        ...entity.source,
        lineStart: entity.source.lineStart,
        lineEnd: Math.min(entity.source.lineEnd, entity.source.lineStart + evidenceLines - 1),
      }));
      const read = ranges.length > 0 ? await options.readRanges(ranges) : { texts: [] };
      const covered = [...entities, ...sourceHints.map((item) => ({ source: item.source }))];
      return {
        status: found.status === 'ambiguous' ? 'ambiguous' : 'ok',
        candidates: entities.map(compactCandidate),
        relations,
        evidence: read.texts.map((item) => ({ ...item })),
        sourceHints,
        primaryScopeCoverage: coverage(covered, preferredScopes),
        truncated: found.truncated === true,
        diagnostics: [],
      };
    },
  };
};
