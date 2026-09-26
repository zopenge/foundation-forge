import type { SourceRef } from '../core/contracts.js';
import type { InvestigationResult, ReadRangeText } from '../investigation/contracts.js';
import type { EvidenceUnit } from '../investigation/evidence-contracts.js';
import { selectEvidence } from '../investigation/evidence-plan.js';
import type { StoredRepositoryGeneration } from '../node/contracts.js';
import { createCursorBinding, decodeCursor, encodeCursor } from './cursor.js';
import type { InvestigationPageRequest, ReadPageRequest, SerializedPage } from './contracts.js';

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let output = '';
  for (const char of value) {
    const next = Buffer.byteLength(char, 'utf8');
    if (bytes + next > maxBytes) break;
    output += char;
    bytes += next;
  }
  return output;
};

interface SourceRow {
  readonly id: string;
  readonly path: string;
  readonly corpusId: string;
  readonly generationId: string;
  readonly sourceSha256: string;
}

const sourceForPath = (generation: StoredRepositoryGeneration, path: string): SourceRef | null => {
  const file = generation.files.find((item) => item.path === path);
  if (!file) return null;
  return {
    corpusId: generation.corpusId, generationId: generation.generationId, path,
    sourceSha256: file.sourceSha256, normalizedSha256: null, snapshotId: null, lineStart: 1, lineEnd: 1,
  };
};
const sourceTable = (sources: readonly SourceRef[]): { readonly rows: readonly SourceRow[]; readonly idByPath: ReadonlyMap<string, string> } => {
  const byPath = new Map<string, SourceRef>();
  for (const source of sources) if (!byPath.has(source.path)) byPath.set(source.path, source);
  const rows = [...byPath.values()].map((source, index) => ({
      id: `s${index}`, path: source.path, corpusId: source.corpusId, generationId: source.generationId,
      sourceSha256: source.sourceSha256,
    }));
  return { rows, idByPath: new Map(rows.map((row) => [row.path, row.id])) };
};

const pageResult = (stdout: string, truncated: boolean, nextCursor: string | null): SerializedPage => ({
  stdout, byteLength: Buffer.byteLength(stdout, 'utf8') + 1, truncated, nextCursor,
});

const ensureBudget = (value: unknown, maxBytes: number): string | null => {
  const stdout = JSON.stringify(value);
  return Buffer.byteLength(stdout, 'utf8') + 1 <= maxBytes ? stdout : null;
};

const cursorRequest = (request: InvestigationPageRequest, strategy: 'standard' | 'planned' = 'standard') => ({
  query: request.query, view: request.view, budget: request.budget,
  evidencePolicy: 'evidence-plan-v4', strategy,
});

const candidateSources = (result: InvestigationResult, generation: StoredRepositoryGeneration): SourceRef[] => result.candidates
  .map((candidate) => sourceForPath(generation, candidate.path))
  .filter((source): source is SourceRef => source !== null);

const compactCandidates = (result: InvestigationResult, generation: StoredRepositoryGeneration, limit: number) => {
  const sources = candidateSources(result, generation);
  const table = sourceTable(sources);
  return {
    candidates: result.candidates.slice(0, limit).map((candidate) => ({
      id: candidate.id, kind: candidate.kind, name: candidate.name,
      sourceId: table.idByPath.get(candidate.path) ?? null,
      lineStart: candidate.lineStart, lineEnd: candidate.lineEnd,
      ...(candidate.signature ? { signature: candidate.signature } : {}),
      evidenceLevel: candidate.evidenceLevel,
    })),
    sources: table.rows,
  };
};

export const serializeInvestigationPage = (
  result: InvestigationResult,
  generation: StoredRepositoryGeneration,
  request: InvestigationPageRequest,
): SerializedPage => {
  const binding = createCursorBinding(generation.generationId, cursorRequest(request), request.scope);
  const plannedBinding = createCursorBinding(generation.generationId,
    cursorRequest(request, 'planned'), request.scope);
  const hasPlannedEvidence = request.view === 'evidence' && (result.evidenceUnits?.length ?? 0) > 0;
  let plannedCursor = false;
  let offset: number;
  if (hasPlannedEvidence && request.cursor !== null) {
    try {
      offset = decodeCursor(request.cursor, plannedBinding);
      plannedCursor = true;
    } catch {
      offset = decodeCursor(request.cursor, binding);
    }
  } else {
    offset = decodeCursor(request.cursor, binding);
  }
  const base = {
    schemaVersion: 1, status: result.status, corpusId: generation.corpusId, generationId: generation.generationId,
    corpusState: generation.corpus.corpusState, coverage: generation.corpus.coverage, view: request.view,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    diagnostics: result.diagnostics, primaryScopeCoverage: result.primaryScopeCoverage,
  };
  const compact = compactCandidates(result, generation, request.budget.maxCandidates);

  if (request.view === 'locate') {
    const slice = compact.candidates.slice(offset, offset + request.budget.maxCandidates);
    const hasMore = offset + slice.length < compact.candidates.length;
    const nextCursor = hasMore ? encodeCursor(binding, offset + slice.length) : null;
    const value = { ...base, candidates: slice, relations: [], evidence: [], sources: compact.sources, truncated: hasMore, nextCursor };
    const stdout = ensureBudget(value, request.budget.maxBytes);
    if (stdout !== null) return pageResult(stdout, hasMore, nextCursor);
    throw Object.assign(new Error('wire budget too small'), { code: 'BUDGET_TOO_SMALL', details: { maxBytes: request.budget.maxBytes } });
  }
  if (request.view === 'relations') {
    if (offset > result.relations.length) throw Object.assign(new Error('cursor mismatch'), { code: 'CURSOR_MISMATCH', details: {} });
    const available = result.relations.length - offset;
    if (available === 0) {
      const value = { ...base, candidates: compact.candidates, relations: [], evidence: [], sources: compact.sources, truncated: false, nextCursor: null };
      const stdout = ensureBudget(value, request.budget.maxBytes);
      if (stdout !== null) return pageResult(stdout, false, null);
      throw Object.assign(new Error('wire budget too small'), { code: 'BUDGET_TOO_SMALL', details: { maxBytes: request.budget.maxBytes } });
    }
    for (let count = Math.min(request.budget.maxRelations, available); count >= 1; count -= 1) {
      const selected = result.relations.slice(offset, offset + count);
      const selectedSources = selected
        .map((relation) => sourceForPath(generation, relation.path))
        .filter((source): source is SourceRef => source !== null);
      const table = sourceTable([...candidateSources(result, generation), ...selectedSources]);
      const candidates = compact.candidates.map((candidate) => ({ ...candidate, sourceId: table.idByPath.get(
        result.candidates.find((item) => item.id === candidate.id)?.path ?? '',
      ) ?? null }));
      const relations = selected.map((relation) => ({
        from: relation.from, to: relation.to, fromPath: relation.fromPath, toPath: relation.toPath,
        kind: relation.kind, resolution: relation.resolution,
        evidenceSourceId: table.idByPath.get(relation.path) ?? null,
        lineStart: relation.lineStart, lineEnd: relation.lineEnd, evidenceLevel: relation.evidenceLevel,
      }));
      const hasMore = offset + count < result.relations.length;
      const nextCursor = hasMore ? encodeCursor(binding, offset + count) : null;
      const value = { ...base, candidates, relations, evidence: [], sources: table.rows, truncated: hasMore, nextCursor };
      const stdout = ensureBudget(value, request.budget.maxBytes);
      if (stdout !== null) return pageResult(stdout, hasMore, nextCursor);
    }
    throw Object.assign(new Error('wire budget too small'), { code: 'BUDGET_TOO_SMALL', details: { maxBytes: request.budget.maxBytes } });
  }
  if (result.evidenceUnits && result.evidenceUnits.length > 0) {
    const hints: EvidenceUnit[] = result.sourceHints.filter((item) => !result.evidenceUnits?.some((unit) => (
      unit.kind === 'excerpt'
      &&
      unit.source.path === item.path && unit.source.sourceSha256 === item.source.sourceSha256
      && unit.source.lineStart <= item.lineEnd && unit.source.lineEnd >= item.lineStart
    ))).map((item, rank) => ({
      id: `hint:${item.path}:${item.lineStart}-${item.lineEnd}`,
      candidateId: `hint:${item.path}:${item.lineStart}-${item.lineEnd}`,
      rank: result.candidates.length + rank,
      kind: 'excerpt', priority: 'support', source: item.source, text: item.text,
    }));
    const alternatives = [...result.evidenceUnits.map((unit) => ({ ...unit,
      baseline: result.evidence.some((item) => item.path === unit.source.path && item.wholeFile === true
        && item.lineStart === unit.source.lineStart && item.lineEnd === unit.source.lineEnd),
    })), ...hints];
    const groupIds = [...new Set(alternatives.map((unit) => unit.candidateId))];
    const render = (units: readonly EvidenceUnit[], lastGroupOffset: number) => {
      const hasMore = lastGroupOffset < groupIds.length;
      const nextCursor = hasMore ? encodeCursor(plannedBinding, lastGroupOffset) : null;
      const table = sourceTable([...candidateSources(result, generation), ...units.map((unit) => unit.source)]);
      const candidates = compact.candidates.map((candidate) => ({ ...candidate, sourceId: table.idByPath.get(
        result.candidates.find((item) => item.id === candidate.id)?.path ?? '',
      ) ?? null }));
      const evidence = units.map((unit) => {
        const file = generation.corpus.entities.find((entity) => entity.kind === 'file'
          && entity.source.path === unit.source.path && entity.source.sourceSha256 === unit.source.sourceSha256);
        const wholeFile = file !== undefined && unit.source.lineStart === file.source.lineStart
          && unit.source.lineEnd === file.source.lineEnd;
        return {
          sourceId: table.idByPath.get(unit.source.path) ?? null, path: unit.source.path,
          lineStart: unit.source.lineStart, lineEnd: unit.source.lineEnd, text: unit.text,
          complete: true, wholeFile, selectedUnit: unit.kind,
          requestedRange: { lineStart: unit.source.lineStart, lineEnd: unit.source.lineEnd },
          deliveredRange: { lineStart: unit.source.lineStart, lineEnd: unit.source.lineEnd },
          ...(wholeFile || file === undefined ? {} : { expansion: {
            path: unit.source.path, lineStart: file.source.lineStart, lineEnd: file.source.lineEnd,
          } }),
        };
      });
      return { ...base, candidates, relations: [], evidence, sources: table.rows,
        truncated: hasMore, hasMoreEvidence: hasMore, internallyTruncated: false, nextCursor };
    };
    const sameSource = (left: EvidenceUnit['source'], right: EvidenceUnit['source']): boolean =>
      left.corpusId === right.corpusId && left.generationId === right.generationId
      && left.path === right.path && left.sourceSha256 === right.sourceSha256;
    const covers = (covering: EvidenceUnit, required: EvidenceUnit): boolean =>
      sameSource(covering.source, required.source)
      && covering.source.lineStart <= required.source.lineStart
      && covering.source.lineEnd >= required.source.lineEnd
      && covering.text.includes(required.text);
    const planPage = (groupOffset: number) => {
      const pageIds = groupIds.slice(groupOffset, groupOffset + request.budget.maxCandidates);
      const pageIdSet = new Set(pageIds);
      const pageOptions = alternatives.filter((unit) => pageIdSet.has(unit.candidateId));
      const candidateOffset = (units: readonly EvidenceUnit[]): number => {
        const chosen = new Set(units.map((unit) => unit.candidateId));
        const firstMissing = pageIds.findIndex((id) => !chosen.has(id)
          && !alternatives.some((option) => option.candidateId === id
            && units.some((selected) => covers(selected, option))));
        return firstMissing < 0 ? groupOffset + pageIds.length : groupOffset + firstMissing;
      };
      const selection = selectEvidence({
        alternatives: pageOptions, query: request.query, budget: { maxBytes: request.budget.maxBytes },
        costModel: { id: 'investigation-json-lines-v1', measure: (units) => ({
          bytes: Buffer.byteLength(JSON.stringify(render(units, candidateOffset(units))), 'utf8') + 1,
        }) },
      });
      if (selection.units.length === 0 && pageIds.length > 0) return null;
      const nextOffset = candidateOffset(selection.units);
      if (nextOffset <= groupOffset && groupOffset < groupIds.length) return null;
      const value = render(selection.units, nextOffset);
      const stdout = ensureBudget(value, request.budget.maxBytes);
      return stdout === null ? null : { units: selection.units, value, stdout, nextOffset };
    };
    const pages = new Map<number, NonNullable<ReturnType<typeof planPage>>>();
    const delivered: EvidenceUnit[] = [];
    let nextOffset = 0;
    while (nextOffset < groupIds.length) {
      const page = planPage(nextOffset);
      if (page === null) break;
      pages.set(nextOffset, page);
      delivered.push(...page.units);
      nextOffset = page.nextOffset;
    }
    const legacyEvidence = [...result.evidence, ...result.sourceHints];
    const completePlan = nextOffset === groupIds.length && legacyEvidence.every((item) =>
      delivered.some((unit) => sameSource(unit.source, item.source)
        && unit.source.lineStart <= item.lineStart && unit.source.lineEnd >= item.lineEnd
        && unit.text.includes(item.text)));
    if (plannedCursor && !completePlan) throw Object.assign(new Error('cursor mismatch'), {
      code: 'CURSOR_MISMATCH', details: {},
    });
    if (completePlan && !(!plannedCursor && request.cursor !== null)) {
      if (offset > groupIds.length || !pages.has(offset)) throw Object.assign(new Error('cursor mismatch'), {
        code: 'CURSOR_MISMATCH', details: {},
      });
      const page = pages.get(offset);
      if (page === undefined) throw Object.assign(new Error('cursor mismatch'), { code: 'CURSOR_MISMATCH', details: {} });
      return pageResult(page.stdout, page.value.truncated, page.value.nextCursor);
    }
  }
  const allEvidence = [...result.evidence, ...result.sourceHints].filter((item, index, all) => (
    all.findIndex((candidate) => candidate.path === item.path && candidate.lineStart === item.lineStart
      && candidate.lineEnd === item.lineEnd && candidate.text === item.text) === index
  ));
  if (offset > allEvidence.length) throw Object.assign(new Error('cursor mismatch'), { code: 'CURSOR_MISMATCH', details: {} });
  const available = allEvidence.length - offset;
  if (available === 0) {
    const value = { ...base, candidates: compact.candidates, relations: [], evidence: [], sources: compact.sources, truncated: false, nextCursor: null };
    const stdout = ensureBudget(value, request.budget.maxBytes);
    if (stdout !== null) return pageResult(stdout, false, null);
    throw Object.assign(new Error('wire budget too small'), { code: 'BUDGET_TOO_SMALL', details: { maxBytes: request.budget.maxBytes } });
  }
  for (let count = Math.min(request.budget.maxCandidates, available); count >= 1; count -= 1) {
    const selected = allEvidence.slice(offset, offset + count);
    const initialTextBudget = Math.max(128, Math.floor((request.budget.maxBytes - 1_500) / count));
    // 正文总量尚未超限时，先按实际响应开销尝试完整返回。
    let textBudget: number | null = selected.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0)
      <= request.budget.maxBytes ? null : initialTextBudget;
    while (textBudget === null || textBudget >= 128) {
      const table = sourceTable([...candidateSources(result, generation), ...selected.map((item) => item.source)]);
      const candidates = compact.candidates.map((candidate) => ({ ...candidate, sourceId: table.idByPath.get(
        result.candidates.find((item) => item.id === candidate.id)?.path ?? '',
      ) ?? null }));
      const evidence = selected.map((item) => {
        const text = textBudget === null ? item.text : truncateUtf8(item.text, textBudget);
        const complete = Buffer.byteLength(text, 'utf8') === Buffer.byteLength(item.text, 'utf8');
        return {
          sourceId: table.idByPath.get(item.path) ?? null, path: item.path,
          lineStart: item.lineStart, lineEnd: item.lineEnd, text, complete,
          wholeFile: item.wholeFile === true && complete,
          deliveredRange: complete ? { lineStart: item.lineStart, lineEnd: item.lineEnd } : null,
          ...(complete ? {} : { expand: { path: item.path, lineStart: item.lineStart, lineEnd: item.lineEnd } }),
        };
      });
      const hasMore = offset + count < allEvidence.length;
      const nextCursor = hasMore ? encodeCursor(binding, offset + count) : null;
      const value = { ...base, candidates, relations: [], evidence, sources: table.rows,
        truncated: hasMore || evidence.some((item) => !item.complete),
        ...(hasMore ? { hasMoreEvidence: true } : {}),
        internallyTruncated: evidence.some((item) => !item.complete), nextCursor };
      const stdout = ensureBudget(value, request.budget.maxBytes);
      if (stdout !== null) return pageResult(stdout, value.truncated, nextCursor);
      const compactEvidence = evidence.map((item) => {
        const copy: Record<string, unknown> = { ...item };
        if (evidence.length > 1) delete copy.deliveredRange;
        return copy;
      });
      const compactValue = { ...base, candidates, relations: [], evidence: compactEvidence, sources: table.rows,
        truncated: value.truncated,
        ...(evidence.length > 1 ? { internallyTruncated: value.internallyTruncated } : {}), nextCursor };
      const compactStdout = ensureBudget(compactValue, request.budget.maxBytes);
      if (compactStdout !== null) return pageResult(compactStdout, value.truncated, nextCursor);
      textBudget = textBudget === null ? initialTextBudget : Math.floor(textBudget * 0.7);
    }
  }
  throw Object.assign(new Error('wire budget too small'), { code: 'BUDGET_TOO_SMALL', details: { maxBytes: request.budget.maxBytes } });
};
export const serializeReadPage = (
  texts: readonly ReadRangeText[],
  generation: StoredRepositoryGeneration,
  request: ReadPageRequest,
): SerializedPage => {
  const binding = createCursorBinding(generation.generationId, { ranges: request.ranges, budget: request.budget }, []);
  const offset = decodeCursor(request.cursor, binding);
  if (offset > texts.length) throw Object.assign(new Error('cursor mismatch'), { code: 'CURSOR_MISMATCH', details: {} });
  const available = texts.length - offset;
  if (available === 0) {
    const value = {
      schemaVersion: 1, status: 'ok', corpusId: generation.corpusId, generationId: generation.generationId,
      corpusState: generation.corpus.corpusState, texts: [], sources: [], truncated: false, nextCursor: null,
    };
    const stdout = ensureBudget(value, request.budget.maxBytes);
    if (stdout !== null) return pageResult(stdout, false, null);
    throw Object.assign(new Error('wire budget too small'), { code: 'BUDGET_TOO_SMALL', details: { maxBytes: request.budget.maxBytes } });
  }
  for (let count = Math.min(16, available); count >= 1; count -= 1) {
    const selected = texts.slice(offset, offset + count);
    const initialTextBudget = Math.max(128, Math.floor((request.budget.maxBytes - 1_200) / count));
    let textBudget: number | null = selected.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0)
      <= request.budget.maxBytes ? null : initialTextBudget;
    while (textBudget === null || textBudget >= 128) {
      const table = sourceTable(selected.map((item) => item.source));
      const projected = selected.map((item) => {
        const text = textBudget === null ? item.text : truncateUtf8(item.text, textBudget);
        const complete = Buffer.byteLength(text, 'utf8') === Buffer.byteLength(item.text, 'utf8');
        return {
          sourceId: table.idByPath.get(item.path) ?? null, path: item.path,
          lineStart: item.lineStart, lineEnd: item.lineEnd, text, complete,
          deliveredRange: complete ? { lineStart: item.lineStart, lineEnd: item.lineEnd } : null,
          ...(complete ? {} : { expand: { path: item.path, lineStart: item.lineStart, lineEnd: item.lineEnd } }),
        };
      });
      const hasMore = offset + count < texts.length;
      const nextCursor = hasMore ? encodeCursor(binding, offset + count) : null;
      const value = {
        schemaVersion: 1, status: 'ok', corpusId: generation.corpusId, generationId: generation.generationId,
        corpusState: generation.corpus.corpusState, texts: projected, sources: table.rows,
        truncated: hasMore || projected.some((item) => !item.complete),
        ...(hasMore ? { hasMoreEvidence: true } : {}),
        internallyTruncated: projected.some((item) => !item.complete), nextCursor,
      };
      const stdout = ensureBudget(value, request.budget.maxBytes);
      if (stdout !== null) return pageResult(stdout, value.truncated, nextCursor);
      const compactTexts = projected.map((item) => {
        const copy: Record<string, unknown> = { ...item };
        delete copy.deliveredRange;
        return copy;
      });
      const compactValue = {
        schemaVersion: 1, status: 'ok', corpusId: generation.corpusId, generationId: generation.generationId,
        corpusState: generation.corpus.corpusState, texts: compactTexts, sources: table.rows,
        truncated: value.truncated, internallyTruncated: value.internallyTruncated, nextCursor,
      };
      const compactStdout = ensureBudget(compactValue, request.budget.maxBytes);
      if (compactStdout !== null) return pageResult(compactStdout, value.truncated, nextCursor);
      textBudget = textBudget === null ? initialTextBudget : Math.floor(textBudget * 0.7);
    }
  }
  throw Object.assign(new Error('wire budget too small'), { code: 'BUDGET_TOO_SMALL', details: { maxBytes: request.budget.maxBytes } });
};
