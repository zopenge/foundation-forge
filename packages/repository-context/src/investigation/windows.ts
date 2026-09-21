import type { SourceRef } from '../core/contracts.js';
import type { SymbolMatch } from './ranking.js';
import {
  affinityToken,
  containsSequence,
  normalizedAffinityTokens,
  queryAnchorSequences,
  rawAffinityTokens,
  structuralIntent,
} from './query.js';

export interface LoadedSource {
  readonly source: SourceRef;
  readonly path: string;
  readonly text: string;
}

export interface RankedWindow {
  readonly source: SourceRef;
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
  readonly score: number;
}

const hasIdentifier = (line: string, name: string): boolean => {
  let index = line.indexOf(name);
  const identifier = /[A-Za-z0-9_$]/u;
  while (index >= 0) {
    const before = index === 0 ? '' : line[index - 1] ?? '';
    const after = index + name.length >= line.length ? '' : line[index + name.length] ?? '';
    if ((before === '' || !identifier.test(before)) && (after === '' || !identifier.test(after))) return true;
    index = line.indexOf(name, index + name.length);
  }
  return false;
};

const lineStructureScore = (line: string, intent: ReturnType<typeof structuralIntent>): number => {
  let score = 0;
  if (intent.numeric) {
    if (/number\.issafeinteger/iu.test(line)) score += 7;
    if (/(?:[<>]=?\s*0|0\s*[<>]=?)/u.test(line)) score += 7;
  }
  if (intent.validation && /\b(?:validate|assert|check|resolve|ensure)[a-z0-9_]*/iu.test(line)) score += 5;
  if ((intent.validation || intent.wrapper) && /\bthrow\b/u.test(line)) score += 4;
  if ((intent.validation || intent.wrapper) && /\bif\s*\(/u.test(line)) score += 2;
  if (/\bcatch\s*\(/u.test(line)) score += intent.wrapper ? 10 : intent.validation ? 3 : 0;
  return score;
};

const symbolWindowContext = (match: SymbolMatch | null, start: number, count: number): number => {
  if (!match) return 0;
  const lineStart = start + 1;
  const lineEnd = start + count;
  const source = match.entity.source;
  if (source.lineEnd < lineStart || source.lineStart > lineEnd) return 0;
  return source.lineStart >= lineStart && source.lineEnd <= lineEnd ? 3 : 2;
};

export const bestWindow = (
  text: string,
  tokens: readonly string[],
  count: number,
  match: SymbolMatch | null,
  anchors: readonly (readonly string[])[] = [],
): Omit<RankedWindow, 'source' | 'path' | 'lineStart' | 'lineEnd'> & { readonly start: number; readonly count: number } => {
  const lines = text.split('\n');
  const intent = structuralIntent(tokens);
  const query = [...new Set(tokens.map(affinityToken))];
  const symbolTokens = match ? normalizedAffinityTokens(match.entity.name) : [];
  const symbolSource = match?.entity.source;
  let lastSymbolUseLine = -1;
  if (symbolTokens.length > 0 && symbolSource) {
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      if (lineNumber >= symbolSource.lineStart && lineNumber <= symbolSource.lineEnd) continue;
      if (hasIdentifier(lines[index] ?? '', match.entity.name)) lastSymbolUseLine = index;
    }
  }
  let best = { score: -1, start: 0, count: Math.min(count, lines.length), text: '' };
  const useAnchorPriority = anchors.length > 0 && !intent.wrapper;
  const strong = !useAnchorPriority && !intent.decodeOrParse && (match?.score ?? 0) >= 30 ? match?.entity.source : null;
  const symbolLength = strong ? strong.lineEnd - strong.lineStart + 1 : null;
  const first = strong
    ? symbolLength !== null && symbolLength <= count ? Math.max(0, strong.lineEnd - count) : Math.max(0, strong.lineStart - 2)
    : 0;
  const strongLast = strong
    ? symbolLength !== null && symbolLength <= count
      ? Math.max(first, Math.min(lines.length - 1, strong.lineStart - 1))
      : Math.max(first, Math.min(lines.length - 1, strong.lineEnd - 1))
    : lines.length - 1;
  const last = strong && lastSymbolUseLine >= 0 ? Math.max(strongLast, Math.min(lines.length - 1, lastSymbolUseLine)) : strongLast;
  for (let start = first; start <= last; start += 1) {
    const size = Math.min(count, lines.length - start);
    let structure = 0;
    const hits = new Set<string>();
    const windowTokens: string[] = [];
    for (let index = start; index < start + size; index += 1) {
      const line = lines[index] ?? '';
      structure += lineStructureScore(line, intent);
      if (!line.trim().startsWith('//')) {
        const lineTokens = normalizedAffinityTokens(line);
        windowTokens.push(...rawAffinityTokens(line));
        for (const token of query) {
          if (lineTokens.some((value) => value === token || value.startsWith(token) || token.startsWith(value))) hits.add(token);
        }
      }
    }
    const symbolUseBonus = lastSymbolUseLine >= start && lastSymbolUseLine < start + size ? 6 : 0;
    const anchorBonus = useAnchorPriority
      ? anchors.reduce((score, sequence) => score + (containsSequence(windowTokens, sequence) ? 48 : 0), 0) : 0;
    const score = Math.min(16, structure) + hits.size * 2 + symbolWindowContext(match, start, size)
      + symbolUseBonus + anchorBonus;
    if (score > best.score) best = { score, start, count: size, text: lines.slice(start, start + size).join('\n') };
  }
  return best;
};

export const bestRecoveryHint = (
  files: readonly LoadedSource[],
  query: string,
  tokens: readonly string[],
  count: number,
  excluded?: Readonly<{ path: string; lineStart: number; lineEnd: number }>,
): RankedWindow | null => {
  const anchors = queryAnchorSequences(query);
  const intent = structuralIntent(tokens);
  const querySet = [...new Set(tokens.map(affinityToken))];
  const identifiers = query.match(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu) ?? [];
  const hyphenated = (query.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/giu) ?? []).map((value) => value.toLowerCase());
  const numbers = query.match(/\b\d{2,}\b/gu) ?? [];
  const decisionIntent = /\b(?:verification|verify|mismatch|reject|raise|invalid|regression|fix|repair|must)\b/iu.test(query);
  let best: RankedWindow | null = null;
  for (const file of files) {
    const lines = file.text.split('\n');
    for (let start = 0; start < lines.length; start += 1) {
      const size = Math.min(count, lines.length - start);
      const lineStart = start + 1;
      const lineEnd = start + size;
      if (file.path === excluded?.path && lineStart <= excluded.lineEnd && lineEnd >= excluded.lineStart) continue;
      const slice = lines.slice(start, start + size);
      const text = slice.join('\n');
      const lower = text.toLowerCase();
      const windowTokens = rawAffinityTokens(text);
      const hits = new Set<string>();
      let structure = 0;
      let maxLineHits = 0;
      for (const line of slice) {
        structure += lineStructureScore(line, intent);
        if (line.trim().startsWith('//')) continue;
        const lineTokens = normalizedAffinityTokens(line);
        const lineHits = querySet.filter((token) => lineTokens.some(
          (value) => value === token || value.startsWith(token) || token.startsWith(value),
        ));
        maxLineHits = Math.max(maxLineHits, lineHits.length);
        for (const token of lineHits) hits.add(token);
      }
      const identifierHits = identifiers.reduce((total, value) => total + slice.filter((line) => hasIdentifier(line, value)).length, 0);
      const hyphenHits = hyphenated.filter((value) => lower.includes(value)).length;
      const numberHits = numbers.filter((value) => new RegExp(`(?:^|[^0-9])${value}(?:$|[^0-9])`, 'u').test(text)).length;
      const anchorHits = anchors.filter((sequence) => containsSequence(windowTokens, sequence)).length;
      const exactTokenHits = querySet.filter((token) => token.length >= 4 && windowTokens.includes(token)).length;
      const decisionScore = decisionIntent ? Math.min(20, slice.reduce((score, line) => score
        + (/\bif\s*\(/u.test(line) ? 4 : 0)
        + (/!==|===|>=|<=|>|</u.test(line) ? 4 : 0)
        + (/\bthrow\b|mismatch/iu.test(line) ? 4 : 0), 0)) : 0;
      const score = hits.size * 3 + Math.min(16, structure) + identifierHits * 18 + hyphenHits * 14
        + numberHits * 24 + anchorHits * 20 + exactTokenHits * 5 + Math.max(0, maxLineHits - 1) * 12
        + decisionScore;
      if (score > (best?.score ?? 0)) best = { source: file.source, path: file.path, lineStart, lineEnd, text, score };
    }
  }
  return best;
};
