import type { Edge, Entity, SourceRef } from '../core/contracts.js';
import { queryRelations } from '../core/relations.js';
import { pathInScope } from '../core/scope.js';
import { searchEntities } from '../core/search.js';
import type {
  InvestigationCandidate,
  InvestigationEvidence,
  InvestigationRelation,
  InvestigationResult,
  ReadRangeText,
  ReadRangesResult,
  RepositoryInvestigator,
  RepositoryInvestigatorOptions,
  ScopeCoverage,
} from './contracts.js';
import { buildEvidenceUnits } from './evidence-units.js';
import { containsSequence, queryAcronyms, queryAnchorSequences, queryFileNames, queryPathScopes,
  queryTokens, scopeNamespaceTokens } from './query.js';
import { bestSymbolMatch } from './ranking.js';
import { createTextIndex, rankTextIndex, type TextIndex } from './text-index.js';
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
  covered: scopes.filter((scope) => entities.some((entity) => pathInScope(entity.source.path, scope))),
  missing: scopes.filter((scope) => !entities.some((entity) => pathInScope(entity.source.path, scope))),
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

const explicitlyNamedSymbol = (entity: Entity, names: ReadonlySet<string>): boolean => entity.kind === 'symbol'
  && names.has(entity.name.normalize('NFKC').toLowerCase());

const queryIdentifierNames = (query: string): ReadonlySet<string> => new Set(
  (query.normalize('NFKC').match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? [])
    .map((name) => name.toLowerCase()),
);

const balanceNamedDirectories = (
  entities: readonly Entity[],
  query: string,
  limit: number,
): Readonly<{ ranked: Entity[]; protectedPaths: ReadonlySet<string> }> => {
  const tokens = queryTokens(query);
  const acronyms = new Set(queryAcronyms(query));
  const heads = new Map<string, Entity>();
  for (const entity of entities) {
    const segments = entity.source.path.split('/');
    let directory: string | null = null;
    for (let index = 1; index < segments.length - 1; index += 1) {
      const directoryTokens = queryTokens(segments[index] ?? '');
      const acronym = directoryTokens.map((token) => token[0]).join('');
      if (directoryTokens.length > 0
        && (containsSequence(tokens, directoryTokens) || acronyms.has(acronym))) {
        directory = segments.slice(0, index + 1).join('/');
      }
    }
    if (directory !== null && !heads.has(directory)) heads.set(directory, entity);
  }
  if (heads.size < 2) return { ranked: [...entities], protectedPaths: new Set() };
  const selectedHeads = [...heads.values()].slice(0, limit);
  const priority = new Set(selectedHeads.map((entity) => entity.source.path));
  return { ranked: [...selectedHeads, ...entities.filter((entity) => !priority.has(entity.source.path))],
    protectedPaths: priority };
};

const narrowerScope = (left: string, right: string): string | null => pathInScope(left, right)
  ? left : pathInScope(right, left) ? right : null;

const sameSourceBinding = (left: SourceRef, right: SourceRef): boolean => left.corpusId === right.corpusId
  && left.generationId === right.generationId && left.path === right.path && left.sourceSha256 === right.sourceSha256;

const sliceCachedText = (cached: ReadRangeText, source: SourceRef): ReadRangeText => {
  const lines = cached.text.split('\n');
  const start = source.lineStart - cached.lineStart;
  const end = source.lineEnd - cached.lineStart + 1;
  return {
    source,
    path: source.path,
    lineStart: source.lineStart,
    lineEnd: source.lineEnd,
    text: lines.slice(start, end).join('\n'),
  };
};

const createQueryReadCache = (
  corpusId: string,
  generationId: string,
  readRanges: RepositoryInvestigatorOptions['readRanges'],
): RepositoryInvestigatorOptions['readRanges'] => {
  const cached: ReadRangeText[] = [];
  return async (ranges): Promise<ReadRangesResult> => {
    const resolved: Array<ReadRangeText | null> = Array.from({ length: ranges.length }, () => null);
    const missing: SourceRef[] = [];
    const indexes: number[] = [];
    for (const [index, source] of ranges.entries()) {
      const hit = cached.find((item) => sameSourceBinding(item.source, source)
        && item.lineStart <= source.lineStart && item.lineEnd >= source.lineEnd);
      if (hit) resolved[index] = sliceCachedText(hit, source);
      else {
        missing.push(source);
        indexes.push(index);
      }
    }
    if (missing.length > 0) {
      const fresh = await readRanges(missing);
      for (const [position, item] of fresh.texts.entries()) {
        cached.push(item);
        const target = indexes[position];
        if (target !== undefined) resolved[target] = item;
      }
    }
    return {
      schemaVersion: 1,
      status: 'ok',
      corpusId,
      generationId,
      diagnostics: [],
      texts: resolved.filter((item): item is ReadRangeText => item !== null),
    };
  };
};

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
  let cachedIndex: TextIndex | null = null;
  const load = async (): Promise<readonly LoadedSource[]> => {
    if (cached !== null) return cached;
    const files = corpus.entities.filter((entity) => entity.kind === 'file'
      && preferredScopes.some((scope) => pathInScope(entity.source.path, scope)));
    if (files.length === 0) {
      cached = [];
      return cached;
    }
    const read = await readRanges(files.map((entity) => entity.source));
    cached = read.texts.map((item) => ({ source: item.source, path: item.path, text: item.text }));
    return cached;
  };
  const loadIndex = async (): Promise<TextIndex> => {
    if (cachedIndex !== null) return cachedIndex;
    cachedIndex = createTextIndex(await load());
    return cachedIndex;
  };
  const find = async (
    query: string,
    candidateEntities: readonly Entity[] = [],
    restrictedPaths: readonly string[] | null = null,
  ): Promise<readonly InvestigationEvidence[]> => {
    const tokens = queryTokens(query);
    if (tokens.length === 0 || preferredScopes.length === 0) return [];
    const anchors = queryAnchorSequences(query);
    const loaded = await load();
    const textIndex = await loadIndex();
    const restricted = new Set(restrictedPaths ?? []);
    const files = restricted.size > 0 ? loaded.filter((item) => restricted.has(item.path)) : loaded;
    const preferred = new Set(candidateEntities.map((entity) => entity.source.path));
    const hints: RankedWindow[] = [];
    for (const scope of preferredScopes) {
      const namespace = scopeNamespaceTokens(scope);
      const filtered = tokens.filter((token) => !namespace.has(token));
      const rankingTokens = filtered.length > 0 ? filtered : tokens;
      const scopedFiles = files.filter((item) => pathInScope(item.path, scope));
      const allowedPaths = new Set(scopedFiles.map((item) => item.path));
      const bodyRanking = rankTextIndex(textIndex, rankingTokens, allowedPaths);
      const bodyScores = new Map(bodyRanking.map((item) => [item.path, item.score]));
      const bodyShortlist = new Set(bodyRanking.slice(0, 8).map((item) => item.path));
      const filesToRank = bodyRanking.length === 0 ? scopedFiles : scopedFiles.filter((item) => (
        bodyShortlist.has(item.path) || preferred.has(item.path) || restricted.has(item.path)
      ));
      const ranked = filesToRank.map((item) => {
        const preferredEntity = candidateEntities.find((entity) => entity.kind === 'symbol' && entity.source.path === item.path);
        const match = bestSymbolMatch(corpus.entities, item.path, rankingTokens, tokens, namespace)
          ?? (preferredEntity ? { entity: preferredEntity, score: 1 } : null);
        const window = bestWindow(item.text, rankingTokens, sourceHintLines, match, anchors);
        const fileTokens = queryTokens(item.path.split('/').at(-1) ?? '');
        const rolePathScore = rankingTokens.some((token) => token === 'decode') && fileTokens.includes('decode') ? 16 : 0;
        const pathScore = rolePathScore
          + rankingTokens.reduce((score, token) => score + (fileTokens.includes(token) ? 1 : 0), 0);
        const bodyScore = Math.min(20, (bodyScores.get(item.path) ?? 0) * 8);
        return { item, window, score: window.score + pathScore + (match?.score ?? 0) + bodyScore };
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
        files.filter((item) => pathInScope(item.path, scope)),
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
  const rank = async (query: string, scopes: readonly string[]): Promise<readonly Readonly<{
    path: string; score: number;
  }>[]> => {
    if (preferredScopes.length === 0) return [];
    const files = await load();
    const allowed = new Set(files.filter((file) => scopes.length === 0
      || scopes.some((scope) => pathInScope(file.path, scope))).map((file) => file.path));
    return rankTextIndex(await loadIndex(), queryTokens(query), allowed);
  };
  return { find, rank };
};

export const createRepositoryInvestigator = (options: RepositoryInvestigatorOptions): RepositoryInvestigator => {
  const maxCandidates = Math.max(1, Math.min(5, options.limits?.maxCandidates ?? 3));
  const evidenceLines = Math.max(1, Math.min(80, options.limits?.evidenceLines ?? 40));
  const sourceHintLines = Math.max(1, Math.min(12, options.limits?.sourceHintLines ?? 10));
  const preferredScopes = options.preferredScopes ?? [];
  const includeEvidence = options.includeEvidence !== false;
  const diversifyCandidates = options.route === 'investigate';
  const pathById = new Map(options.corpus.entities.map((entity) => [entity.id, entity.source.path]));
  const fileSourceByPath = new Map(options.corpus.entities.filter((entity) => entity.kind === 'file')
    .map((entity) => [entity.source.path, entity.source]));
  const knownRoots = new Set(options.corpus.entities.map((entity) => entity.source.path.split('/')[0] ?? ''));
  const fileIdByPath = new Map(options.corpus.entities.filter((entity) => entity.kind === 'file')
    .map((entity) => [entity.source.path, entity.id]));

  return {
    investigate: async ({ query, scope, evidenceBudget }): Promise<InvestigationResult> => {
      if (query.trim().length === 0) {
        return {
          status: 'error', reason: 'INVALID_ARGUMENT', candidates: [], relations: [], evidence: [], sourceHints: [],
          primaryScopeCoverage: coverage([], preferredScopes),
          diagnostics: [{ code: 'INVALID_ARGUMENT', details: { field: 'query' } }],
        };
      }
      const explicitScopes = scope ?? [];
      const scopeParents = explicitScopes.length > 0 ? explicitScopes : preferredScopes;
      const promotedScopes = queryPathScopes(query, knownRoots).filter((candidate) => (
        scopeParents.length === 0 || scopeParents.some((parent) => pathInScope(candidate, parent))
      ));
      const promotedFileScopes = promotedScopes.filter((path) => fileSourceByPath.has(path));
      const namedFiles = promotedScopes.length === 0 ? queryFileNames(query) : [];
      const fileNameScopes = namedFiles.map((name) => [...fileSourceByPath.keys()].filter((path) =>
        path.split('/').at(-1) === name && (scopeParents.length === 0
          || scopeParents.some((parent) => pathInScope(path, parent)))));
      const uniqueFileScopes = fileNameScopes.length > 0 && fileNameScopes.every((matches) => matches.length === 1)
        ? [...new Set(fileNameScopes.flat())] : [];
      const requestedScopes = promotedScopes.length > 0 ? promotedScopes
        : uniqueFileScopes.length > 0 ? uniqueFileScopes : explicitScopes;
      const effectiveScopes = requestedScopes.length > 0 ? requestedScopes : preferredScopes;
      const requestedScopeCoverage = requestedScopes.length > 0
        ? coverage(options.corpus.entities, requestedScopes)
        : null;
      if (requestedScopeCoverage !== null && requestedScopeCoverage.covered.length === 0) {
        return {
          status: 'insufficient',
          reason: 'REQUESTED_SCOPE_MISSING',
          candidates: [],
          relations: [],
          evidence: [],
          sourceHints: [],
          primaryScopeCoverage: requestedScopeCoverage,
          diagnostics: [{ code: 'REQUESTED_SCOPE_MISSING', details: { scopes: [...requestedScopes] } }],
        };
      }
      const queryReadRanges = createQueryReadCache(
        options.corpus.corpusId,
        options.corpus.generationId,
        options.readRanges,
      );
      const sourceHintFinder = createSourceHintFinder({
        corpus: options.corpus,
        readRanges: queryReadRanges,
        preferredScopes: effectiveScopes,
        sourceHintLines,
      });
      let found;
      const hasRequestedScope = requestedScopes.length > 0;
      const activePreferred = hasRequestedScope ? [...new Set(preferredScopes.flatMap((prefix) =>
        requestedScopes.map((requested) => narrowerScope(prefix, requested))
          .filter((scope): scope is string => scope !== null)))] : preferredScopes;
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
        const effectiveScope = hasRequestedScope
          ? requestedScopes
          : (preferredScopes.length > 0 ? preferredScopes : undefined);
        found = searchEntities(options.corpus, {
          by: 'text',
          value: query,
          ...(effectiveScope === undefined ? {} : { scope: effectiveScope }),
          limit: diversifyCandidates ? 100 : maxCandidates,
        });
      }
      if (!hasRequestedScope && preferredScopes.length > 0 && (found.status === 'no-match' || found.entities.length === 0)) {
        found = searchEntities(options.corpus, { by: 'text', value: query,
          limit: diversifyCandidates ? 100 : maxCandidates });
      }
      const seenPaths = new Set<string>();
      const locateTokens = diversifyCandidates ? queryTokens(query) : [];
      const locateAcronyms = diversifyCandidates ? queryAcronyms(query) : [];
      const namedSymbols = diversifyCandidates ? queryIdentifierNames(query) : new Set<string>();
      const initiallyRanked = diversifyCandidates ? found.entities.flatMap((entity, position) => {
        if (seenPaths.has(entity.source.path)) return [];
        seenPaths.add(entity.source.path);
        const match = bestSymbolMatch(found.entities, entity.source.path, locateTokens,
          locateTokens, new Set(), locateAcronyms);
        return [{ entity: match?.entity ?? entity, score: match?.score ?? 0, position }];
      }).sort((left, right) => Number(explicitlyNamedSymbol(right.entity, namedSymbols))
        - Number(explicitlyNamedSymbol(left.entity, namedSymbols))
        || right.score - left.score || left.position - right.position)
        .map((item) => item.entity) : [...found.entities];
      const balanced = diversifyCandidates && !initiallyRanked.slice(0, maxCandidates)
        .some((entity) => explicitlyNamedSymbol(entity, namedSymbols))
        ? balanceNamedDirectories(initiallyRanked, query, maxCandidates)
        : { ranked: initiallyRanked, protectedPaths: new Set<string>() };
      const rankedEntities = balanced.ranked;
      if (diversifyCandidates && includeEvidence && maxCandidates > 1 && queryTokens(query).length >= 3) {
        const bodyLeader = (await sourceHintFinder.rank(query, requestedScopes))[0];
        if (bodyLeader !== undefined && !rankedEntities.slice(0, maxCandidates)
          .some((entity) => entity.source.path === bodyLeader.path)) {
          const representative = bestSymbolMatch(options.corpus.entities, bodyLeader.path,
            queryTokens(query))?.entity
            ?? options.corpus.entities.find((entity) => entity.kind === 'file'
              && entity.source.path === bodyLeader.path);
          const replaceIndex = rankedEntities.slice(0, maxCandidates)
            .findLastIndex((entity) => !explicitlyNamedSymbol(entity, namedSymbols)
              && !balanced.protectedPaths.has(entity.source.path));
          if (representative !== undefined && replaceIndex >= 0) {
            rankedEntities.splice(replaceIndex, 0, representative);
          }
        }
      }
      const entities = rankedEntities.slice(0, maxCandidates);
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
            && effectiveScopes.some((prefix) => pathInScope(path, prefix))))]
        : [];
      const baseSourceHints = includeEvidence ? await sourceHintFinder.find(query, found.entities,
        promotedFileScopes.length > 0 ? promotedFileScopes
          : uniqueFileScopes.length > 0 ? uniqueFileScopes : null) : [];
      const relationSourceHints = includeEvidence && relationEndpointPaths.length > 0
        ? await sourceHintFinder.find(query, [], relationEndpointPaths)
        : [];
      const sourceHints = options.route === 'investigate-relations' && options.promoteRelationEndpoints === true
        ? [...relationSourceHints, ...baseSourceHints]
          .filter((item, index, all) => all.findIndex((row) => row.path === item.path) === index)
          .slice(0, maxCandidates)
        : baseSourceHints;
      if ((found.status === 'no-match' || found.entities.length === 0) && sourceHints.length === 0
        && entities.length === 0) {
        return {
          status: 'insufficient', reason: 'NO_USEFUL_CANDIDATE', candidates: [], relations: [], evidence: [], sourceHints: [],
          primaryScopeCoverage: coverage([], preferredScopes), diagnostics: [],
        };
      }
      const evidenceEntities = entities.filter((entity, index, all) => (
        all.findIndex((candidate) => candidate.source.path === entity.source.path) === index
      ));
      const ranges = includeEvidence ? evidenceEntities.map((entity) => {
        const fileSource = fileSourceByPath.get(entity.source.path);
        const source = fileSource !== undefined
          && fileSource.lineEnd - fileSource.lineStart + 1 <= evidenceLines
          ? fileSource : entity.source;
        return { ...source,
          lineStart: source.lineStart,
          lineEnd: Math.min(source.lineEnd, source.lineStart + evidenceLines - 1),
        };
      }) : [];
      const read = ranges.length > 0 ? await queryReadRanges(ranges) : { texts: [] };
      const evidenceUnits = includeEvidence && evidenceBudget !== undefined ? await buildEvidenceUnits({
        corpus: options.corpus, candidates: evidenceEntities, readRanges: queryReadRanges,
      }) : undefined;
      const covered = [...entities, ...sourceHints.map((item) => ({ source: item.source }))];
      return {
        status: found.status === 'ambiguous' ? 'ambiguous' : 'ok',
        candidates: entities.map(compactCandidate),
        relations,
        evidence: read.texts.map((item) => {
          const fileSource = fileSourceByPath.get(item.path);
          return { ...item, wholeFile: fileSource !== undefined
            && item.lineStart === fileSource.lineStart && item.lineEnd === fileSource.lineEnd };
        }),
        ...(evidenceUnits === undefined ? {} : { evidenceUnits }),
        sourceHints,
        primaryScopeCoverage: coverage(covered, preferredScopes),
        truncated: found.truncated === true || rankedEntities.length > maxCandidates,
        diagnostics: [],
      };
    },
  };
};
