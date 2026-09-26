import { expect, test } from 'vitest';
import type { Corpus } from '../src/core/contracts.js';
import type { InvestigationResult } from '../src/investigation/contracts.js';
import type { EvidenceUnit } from '../src/investigation/evidence-contracts.js';
import type { StoredRepositoryGeneration } from '../src/node/contracts.js';
import { serializeInvestigationPage, serializeReadPage } from '../src/presentation/page.js';
import { sourceRef } from './repository-fixtures.js';

const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
const source = (path: string, lineStart: number, lineEnd: number) =>
  sourceRef(path, lineStart, lineEnd);
const evidence = (path: string, lineStart: number, lineEnd: number, text: string) => ({
  source: source(path, lineStart, lineEnd), path, lineStart, lineEnd, text, wholeFile: false,
});
const unit = (id: string, path: string, lineStart: number, lineEnd: number,
  text: string, rank: number): EvidenceUnit => ({
  id, candidateId: id, rank, kind: 'excerpt', priority: 'primary',
  source: source(path, lineStart, lineEnd), text,
});
const corpus: Corpus = { corpusId: 'fixture', generationId: 'g1', corpusState: 'frozen',
  coverage: 'complete-in-declared-scope', edges: [], entities: paths.map((path) => ({
    id: `file:${path}`, kind: 'file', name: path, owner: null, signature: null,
    evidenceLevel: 'literal-path', source: source(path, 1, 400),
  })) };
const generation: StoredRepositoryGeneration = {
  schemaVersion: 2, corpusId: 'fixture', generationId: 'g1', inputDigest: 'fixture',
  scopes: ['src'], languages: ['typescript'], files: paths.map((path) => ({
    path, sourceSha256: 'a'.repeat(64), size: 10000,
  })), semanticConfigPath: null, semanticInputs: [], configurationDigest: 'fixture',
  extractorVersion: 'fixture', sortingVersion: 'fixture', corpus,
};

test('完整调查响应能装入总预算时，不因短辅助片段的平均份额而截断主证据', () => {
  const texts = [evidence('src/a.ts', 1, 1, 'a'.repeat(2_000)),
    evidence('src/b.ts', 1, 1, 'support')];
  const result: InvestigationResult = {
    status: 'ok', candidates: [], relations: [], evidence: texts, sourceHints: [],
    primaryScopeCoverage: { covered: [], missing: [] }, diagnostics: [],
  };
  const request = { corpusId: 'fixture', generationId: 'g1', query: 'a', scope: [],
    view: 'evidence' as const, cursor: null,
    budget: { maxBytes: 4096, maxCandidates: 3, maxRelations: 8 } };
  const complete = serializeInvestigationPage(result, generation, {
    ...request, budget: { ...request.budget, maxBytes: 16_384 },
  });
  expect(complete.byteLength).toBeLessThanOrEqual(request.budget.maxBytes);
  const page = serializeInvestigationPage(result, generation, request);
  const parsed = JSON.parse(page.stdout) as { evidence: Array<{
    text: string; complete: boolean; deliveredRange: unknown;
  }>; internallyTruncated: boolean };
  expect(page.byteLength).toBeLessThanOrEqual(request.budget.maxBytes);
  expect(parsed.evidence.map(({ text }) => text)).toEqual(texts.map(({ text }) => text));
  expect(parsed.evidence.every(({ complete }) => complete)).toBe(true);
  expect(parsed.evidence.map(({ deliveredRange }) => deliveredRange)).toEqual([
    { lineStart: 1, lineEnd: 1 }, { lineStart: 1, lineEnd: 1 },
  ]);
  expect(parsed.internallyTruncated).toBe(false);
  expect(page.truncated).toBe(false);
  expect(page.nextCursor).toBeNull();
});

test('完整批量读取能装入总预算时，不因短片段的平均份额而截断长片段', () => {
  const texts = [evidence('src/a.ts', 1, 1, 'a'.repeat(2_000)),
    evidence('src/b.ts', 1, 1, 'support')];
  const request = { corpusId: 'fixture', generationId: 'g1', cursor: null,
    ranges: texts.map(({ path, lineStart, lineEnd }) => ({ path, lineStart, lineEnd })),
    budget: { maxBytes: 4096, maxCandidates: 3, maxRelations: 8 } };
  const complete = serializeReadPage(texts, generation, {
    ...request, budget: { ...request.budget, maxBytes: 16_384 },
  });
  expect(complete.byteLength).toBeLessThanOrEqual(request.budget.maxBytes);
  const page = serializeReadPage(texts, generation, request);
  const parsed = JSON.parse(page.stdout) as { texts: Array<{
    text: string; complete: boolean; deliveredRange: unknown;
  }>; internallyTruncated: boolean };
  expect(page.byteLength).toBeLessThanOrEqual(request.budget.maxBytes);
  expect(parsed.texts.map(({ text }) => text)).toEqual(texts.map(({ text }) => text));
  expect(parsed.texts.every(({ complete }) => complete)).toBe(true);
  expect(parsed.texts.map(({ deliveredRange }) => deliveredRange)).toEqual([
    { lineStart: 1, lineEnd: 1 }, { lineStart: 1, lineEnd: 1 },
  ]);
  expect(parsed.internallyTruncated).toBe(false);
  expect(page.truncated).toBe(false);
  expect(page.nextCursor).toBeNull();
});

test.each(['\\'.repeat(2_000), '🙂'.repeat(1_000)])('正文未超限但完整 JSON 超限时，调查与读取继续安全裁剪', (text) => {
  const item = evidence('src/a.ts', 1, 1, text);
  const budget = { maxBytes: 4096, maxCandidates: 3, maxRelations: 8 };
  const result: InvestigationResult = {
    status: 'ok', candidates: [], relations: [], evidence: [item], sourceHints: [],
    primaryScopeCoverage: { covered: [], missing: [] }, diagnostics: [],
  };
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget.maxBytes);
  const pages = [serializeInvestigationPage(result, generation, {
    corpusId: 'fixture', generationId: 'g1', query: 'a', scope: [], view: 'evidence', cursor: null, budget,
  }), serializeReadPage([item], generation, {
    corpusId: 'fixture', generationId: 'g1', ranges: [{ path: item.path, lineStart: 1, lineEnd: 1 }],
    cursor: null, budget,
  })];
  for (const page of pages) {
    const parsed = JSON.parse(page.stdout) as {
      evidence?: Array<{ text: string; complete: boolean; deliveredRange: unknown }>;
      texts?: Array<{ text: string; complete: boolean; deliveredRange: unknown }>;
      internallyTruncated: boolean;
    };
    const delivered = (parsed.evidence ?? parsed.texts)?.[0];
    expect(page.byteLength).toBeLessThanOrEqual(budget.maxBytes);
    expect(delivered?.complete).toBe(false);
    expect(delivered?.deliveredRange).toBeNull();
    expect(delivered?.text).not.toContain('\uFFFD');
    expect(text.startsWith(delivered?.text ?? '')).toBe(true);
    expect(parsed.internallyTruncated).toBe(true);
    expect(page.truncated).toBe(true);
  }
});

test('大单行与支持片段混合时，服务返回的每个 evidence 游标均可续页且不丢范围', () => {
  const big = 'X'.repeat(9000);
  const result: InvestigationResult = {
    status: 'ok', candidates: paths.map((path, index) => ({
      id: `c${index}`, kind: 'symbol', name: `f${index}`, path,
      lineStart: 10, lineEnd: 10, evidenceLevel: 'syntax',
    })), relations: [],
    evidence: paths.map((path) => evidence(path, 10, 10, big)),
    sourceHints: [
      evidence(paths[0] ?? '', 9, 10, `pre\n${big}`),
      evidence(paths[0] ?? '', 10, 11, `${big}\npost`),
      evidence(paths[1] ?? '', 9, 10, `pre\n${big}`),
      evidence(paths[2] ?? '', 10, 11, `${big}\npost`),
    ],
    evidenceUnits: paths.map((path, index) => unit(`c${index}`, path, 10, 10, big, index)),
    primaryScopeCoverage: { covered: [], missing: [] }, diagnostics: [],
  };
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  const seenRanges = new Set<string>();
  let pageCount = 0;
  do {
    const page = serializeInvestigationPage(result, generation, {
      corpusId: 'fixture', generationId: 'g1', query: 'f', scope: [], view: 'evidence', cursor,
      budget: { maxBytes: 4096, maxCandidates: 3, maxRelations: 8 },
    });
    expect(page.byteLength).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(page.stdout) as { evidence: Array<{
      path: string; lineStart: number; lineEnd: number;
    }>; nextCursor: string | null };
    for (const row of parsed.evidence) seenRanges.add(`${row.path}:${row.lineStart}-${row.lineEnd}`);
    cursor = parsed.nextCursor;
    if (cursor !== null) {
      expect(seenCursors.has(cursor)).toBe(false);
      seenCursors.add(cursor);
    }
    pageCount += 1;
    expect(pageCount).toBeLessThan(12);
  } while (cursor !== null);
  expect(pageCount).toBeGreaterThanOrEqual(3);
  expect(seenRanges.has('src/c.ts:10-11')).toBe(true);
});

test('同一来源的不相交证据不会因为路径相同而跳过第二段', () => {
  const path = 'src/a.ts';
  const result: InvestigationResult = {
    status: 'ok', candidates: [
      { id: 'first', kind: 'symbol', name: 'first', path, lineStart: 1, lineEnd: 1, evidenceLevel: 'syntax' },
      { id: 'second', kind: 'symbol', name: 'second', path, lineStart: 10, lineEnd: 10, evidenceLevel: 'syntax' },
    ], relations: [],
    evidence: [evidence(path, 1, 1, 'A'.repeat(2200)), evidence(path, 10, 10, 'B'.repeat(2200))],
    sourceHints: [], evidenceUnits: [
      unit('first', path, 1, 1, 'A'.repeat(2200), 0),
      unit('second', path, 10, 10, 'B'.repeat(2200), 1),
    ], primaryScopeCoverage: { covered: [], missing: [] }, diagnostics: [],
  };
  const request = { corpusId: 'fixture', generationId: 'g1', query: 'first second', scope: [],
    view: 'evidence' as const, budget: { maxBytes: 4096, maxCandidates: 2, maxRelations: 8 } };
  const first = JSON.parse(serializeInvestigationPage(result, generation, { ...request, cursor: null }).stdout) as {
    evidence: Array<{ lineStart: number; selectedUnit?: string }>; nextCursor: string | null;
  };
  expect(first.evidence.map((item) => item.lineStart)).toEqual([1]);
  expect(first.evidence[0]?.selectedUnit).toBe('excerpt');
  expect(first.nextCursor).not.toBeNull();
  const second = JSON.parse(serializeInvestigationPage(result, generation, {
    ...request, cursor: first.nextCursor,
  }).stdout) as { evidence: Array<{ lineStart: number }>; nextCursor: string | null };
  expect(second.evidence.map((item) => item.lineStart)).toEqual([10]);
  expect(second.nextCursor).toBeNull();
});
