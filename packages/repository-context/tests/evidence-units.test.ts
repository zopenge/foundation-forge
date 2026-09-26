import { expect, test } from 'vitest';
import type { Corpus, Entity, SourceRef } from '../src/core/contracts.js';
import { buildEvidenceUnits } from '../src/investigation/evidence-units.js';

const source = (lineStart: number, lineEnd: number, sha = 'a'.repeat(64)): SourceRef => ({
  corpusId: 'fixture', generationId: 'g1', path: 'src/example.ts', sourceSha256: sha,
  normalizedSha256: null, snapshotId: null, lineStart, lineEnd,
});
const entity = (id: string, kind: Entity['kind'], lineStart: number, lineEnd: number): Entity => ({
  id, kind, name: id, owner: null, signature: null, source: source(lineStart, lineEnd), evidenceLevel: 'syntax',
});
const lines = Array.from({ length: 78 }, (_, index) => `line ${index + 1}`);
const corpus: Corpus = {
  corpusId: 'fixture', generationId: 'g1', corpusState: 'frozen', coverage: 'complete-in-declared-scope',
  entities: [entity('file', 'file', 1, 78), entity('local', 'symbol', 17, 17),
    entity('function', 'symbol', 13, 22)], edges: [],
};
const candidate = corpus.entities[1] as Entity;
const file = corpus.entities[0] as Entity;
const readRanges = async (ranges: readonly SourceRef[]) => ({
  schemaVersion: 1 as const, status: 'ok' as const, corpusId: 'fixture', generationId: 'g1', diagnostics: [],
  texts: ranges.map((range) => ({ source: range, path: range.path, lineStart: range.lineStart,
    lineEnd: range.lineEnd, text: lines.slice(range.lineStart - 1, range.lineEnd).join('\n') })),
});

test('局部单行候选给出包围函数与完整短文件升级选项', async () => {
  const units = await buildEvidenceUnits({ corpus, candidates: [candidate], readRanges });
  expect(units.map((unit) => [unit.kind, unit.source.lineStart, unit.source.lineEnd])).toEqual([
    ['excerpt', 17, 17], ['enclosing-symbol', 13, 22], ['file', 1, 78],
  ]);
  expect(units[1]?.text).toContain('line 17');
  expect(units[2]?.text).toContain('line 78');
});

test('没有可信包围边界时不伪造 enclosing-symbol', async () => {
  const units = await buildEvidenceUnits({
    corpus: { ...corpus, entities: [file, candidate] },
    candidates: [candidate], readRanges,
  });
  expect(units.some((unit) => unit.kind === 'enclosing-symbol')).toBe(false);
});

test('来源版本不同的范围不能作为升级选项', async () => {
  const changed = entity('changed', 'symbol', 13, 22);
  const units = await buildEvidenceUnits({
    corpus: { ...corpus, entities: [file, candidate,
      { ...changed, source: source(13, 22, 'b'.repeat(64)) }] },
    candidates: [candidate], readRanges,
  });
  expect(units.some((unit) => unit.kind === 'enclosing-symbol')).toBe(false);
});

test('generation 变化时不能把旧语义范围用于新证据', async () => {
  const oldFunction = entity('old-function', 'symbol', 13, 22);
  const units = await buildEvidenceUnits({
    corpus: { ...corpus, entities: [file, candidate,
      { ...oldFunction, source: { ...oldFunction.source, generationId: 'g0' } }] },
    candidates: [candidate], readRanges,
  });
  expect(units.some((unit) => unit.kind === 'enclosing-symbol')).toBe(false);
});

test('超长关联文件不会无条件读取并交付全文', async () => {
  const longCorpus = { ...corpus, entities: [entity('long-file', 'file', 1, 1_000), candidate] };
  const units = await buildEvidenceUnits({ corpus: longCorpus, candidates: [candidate], readRanges });
  expect(units.some((unit) => unit.kind === 'file')).toBe(false);
});
