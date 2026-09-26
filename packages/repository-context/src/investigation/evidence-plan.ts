import type { EvidenceUnit } from './evidence-contracts.js';
import { queryTokens } from './query.js';

export interface EvidenceSelectionRequest {
  readonly alternatives: readonly EvidenceUnit[];
  readonly query?: string;
  readonly budget: Readonly<{ maxBytes: number }>;
  readonly costModel: Readonly<{ id: string; measure(units: readonly EvidenceUnit[]): Readonly<{ bytes: number }> }>;
}

export interface EvidenceSelection {
  readonly units: readonly EvidenceUnit[];
  readonly bytes: number;
  readonly omittedCandidateIds: readonly string[];
  readonly policyVersion: string;
}

const sameSource = (left: EvidenceUnit, right: EvidenceUnit): boolean => left.source.corpusId === right.source.corpusId
  && left.source.generationId === right.source.generationId && left.source.path === right.source.path
  && left.source.sourceSha256 === right.source.sourceSha256;

const covered = (unit: EvidenceUnit, selected: readonly EvidenceUnit[]): boolean => selected.some((item) => sameSource(unit, item)
  && item.source.lineStart <= unit.source.lineStart && item.source.lineEnd >= unit.source.lineEnd);

const overlaps = (left: EvidenceUnit, right: EvidenceUnit): boolean => sameSource(left, right)
  && left.source.lineStart <= right.source.lineEnd && left.source.lineEnd >= right.source.lineStart;

const uncoveredPieces = (unit: EvidenceUnit, selected: readonly EvidenceUnit[]): EvidenceUnit[] => {
  const lines = unit.text.split('\n');
  if (lines.length !== unit.source.lineEnd - unit.source.lineStart + 1) return [unit];
  let intervals: Array<readonly [number, number]> = [[unit.source.lineStart, unit.source.lineEnd]];
  for (const item of selected) {
    if (!sameSource(unit, item)) continue;
    intervals = intervals.flatMap(([start, end]) => {
      if (item.source.lineEnd < start || item.source.lineStart > end) return [[start, end] as const];
      return [
        ...(item.source.lineStart > start ? [[start, item.source.lineStart - 1] as const] : []),
        ...(item.source.lineEnd < end ? [[item.source.lineEnd + 1, end] as const] : []),
      ];
    });
  }
  return intervals.map(([lineStart, lineEnd]) => lineStart === unit.source.lineStart && lineEnd === unit.source.lineEnd
    ? unit : {
      ...unit, id: `${unit.id}:${lineStart}-${lineEnd}`, kind: 'excerpt',
      source: { ...unit.source, lineStart, lineEnd },
      text: lines.slice(lineStart - unit.source.lineStart, lineEnd - unit.source.lineStart + 1).join('\n'),
    });
};

const kindRank = (kind: EvidenceUnit['kind']): number => kind === 'excerpt' ? 0 : kind === 'enclosing-symbol' ? 1 : 2;
const optionalFileExpansionLimitBytes = 4096;

export const selectEvidence = ({ alternatives, query, budget, costModel }: EvidenceSelectionRequest): EvidenceSelection => {
  if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) {
    throw Object.assign(new Error('invalid evidence budget'), { code: 'INVALID_ARGUMENT' });
  }
  const groups = new Map<string, EvidenceUnit[]>();
  for (const unit of alternatives) {
    const existing = groups.get(unit.candidateId) ?? [];
    existing.push(unit);
    groups.set(unit.candidateId, existing);
  }
  const ordered = [...groups.entries()].sort((left, right) => {
    const a = left[1][0];
    const b = right[1][0];
    if (!a || !b) return 0;
    return (a.priority === 'primary' ? 0 : 1) - (b.priority === 'primary' ? 0 : 1)
      || a.rank - b.rank || left[0].localeCompare(right[0]);
  });
  const selected: EvidenceUnit[] = [];
  const omitted: string[] = [];
  const queryTerms = query === undefined ? null : new Set(queryTokens(query));
  const measured = (units: readonly EvidenceUnit[]): number => {
    const bytes = costModel.measure(units).bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Object.assign(new Error('invalid evidence cost'), { code: 'INVALID_ARGUMENT' });
    return bytes;
  };
  if (measured([]) > budget.maxBytes) {
    throw Object.assign(new Error('evidence budget too small'), { code: 'BUDGET_TOO_SMALL' });
  }
  for (const [position, [, options]] of ordered.entries()) {
    const anchor = [...options].sort((a, b) => kindRank(a.kind) - kindRank(b.kind))[0];
    if (!anchor) continue;
    const pieces = uncoveredPieces(anchor, selected);
    if (pieces.length === 0) continue;
    if (measured([...selected, ...pieces]) <= budget.maxBytes) selected.push(...pieces);
    else {
      omitted.push(...ordered.slice(position).map(([id]) => id));
      break;
    }
  }
  for (const [candidateId, options] of ordered) {
    if (!selected.some((item) => item.candidateId === candidateId)) continue;
    for (const option of [...options].sort((a, b) => kindRank(a.kind) - kindRank(b.kind))) {
      const own = selected.filter((item) => item.candidateId === candidateId);
      const other = selected.filter((item) => item.candidateId !== candidateId && !covered(item, [option]));
      if (own.length === 1 && option.id === own[0]?.id) continue;
      if (option.kind === 'file' && option.baseline !== true && queryTerms !== null) {
        const incrementalBytes = measured([...other, option]) - measured(selected);
        const fairShare = budget.maxBytes / Math.max(4, ordered.length * 3);
        const fileName = option.source.path.split('/').at(-1)?.replace(/\.[^.]+$/u, '') ?? '';
        const fileTerms = queryTokens(fileName).filter((term) => term.length >= 4);
        const namedFile = fileTerms.length > 0 && fileTerms.every((term) => queryTerms.has(term));
        // 大文件需有明确文件名意图；正文偶然新增一个查询词不构成全文展开依据。
        if (option.priority === 'support'
          && incrementalBytes > Math.min(fairShare, optionalFileExpansionLimitBytes)) continue;
        if (!namedFile && incrementalBytes > fairShare) continue;
      }
      if (covered(option, other) || other.some((item) => overlaps(option, item))) continue;
      const trial = [...other, option].sort((a, b) => a.rank - b.rank);
      if (measured(trial) <= budget.maxBytes) selected.splice(0, selected.length, ...trial);
    }
  }
  const bytes = measured(selected);
  if (bytes > budget.maxBytes) {
    throw Object.assign(new Error('evidence budget too small'), { code: 'BUDGET_TOO_SMALL' });
  }
  return { units: selected, bytes, omittedCandidateIds: omitted, policyVersion: 'evidence-plan-v3' };
};
