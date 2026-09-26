import { expect, test } from 'vitest';
import { selectEvidence } from '../src/investigation/evidence-plan.js';
import type { EvidenceUnit } from '../src/investigation/evidence-contracts.js';

const unit = (candidateId: string, rank: number, kind: EvidenceUnit['kind'],
  lineStart: number, lineEnd: number, text: string, priority: EvidenceUnit['priority'] = 'primary'): EvidenceUnit => ({
  id: `${candidateId}:${kind}`, candidateId, rank, kind, priority, text,
  source: { corpusId: 'fixture', generationId: 'g1', path: `src/${candidateId}.ts`,
    sourceSha256: candidateId.padEnd(64, 'a'), normalizedSha256: null, snapshotId: null,
    lineStart, lineEnd },
});
const measure = (units: readonly EvidenceUnit[]) => ({ bytes: Buffer.byteLength(JSON.stringify({
  schemaVersion: 1, evidence: units,
}), 'utf8') + 1 });

test('关联全文不能挤掉已选的主要证据', () => {
  const primary = unit('a', 0, 'excerpt', 1, 1, 'x'.repeat(2_500));
  const support = unit('b', 1, 'file', 1, 20, 'y'.repeat(8_000), 'support');
  const result = selectEvidence({ alternatives: [primary, support], budget: { maxBytes: 4096 },
    costModel: { id: 'test-json', measure } });
  expect(result.units.map((item) => item.id)).toEqual([primary.id]);
  expect(result.bytes).toBeLessThanOrEqual(4096);
});

test('预算充足时升级短关联文件，重叠候选不重复消费预算', () => {
  const anchor = unit('a', 0, 'excerpt', 3, 3, 'line 3');
  const enclosing = unit('a', 0, 'enclosing-symbol', 1, 5, 'line 1\nline 2\nline 3\nline 4\nline 5');
  const file = unit('a', 0, 'file', 1, 5, enclosing.text);
  const duplicate = { ...anchor, id: 'duplicate', candidateId: 'b', rank: 1 };
  const result = selectEvidence({ alternatives: [anchor, enclosing, file, duplicate],
    budget: { maxBytes: 4096 }, costModel: { id: 'test-json', measure } });
  expect(result.units.map((item) => item.kind)).toEqual(['file']);
  expect(result.units.some((item) => item.id === duplicate.id)).toBe(false);
});

test('4 KB 下先保留多份主要锚点，再尝试升级', () => {
  const first = unit('a', 0, 'excerpt', 1, 10, 'x'.repeat(900));
  const second = unit('b', 1, 'excerpt', 1, 10, 'y'.repeat(900));
  const third = unit('c', 2, 'file', 1, 77, 'z'.repeat(2_077), 'support');
  const result = selectEvidence({ alternatives: [first, second, third],
    budget: { maxBytes: 4096 }, costModel: { id: 'test-json', measure } });
  expect(result.units.map((item) => item.id)).toEqual([first.id, second.id]);
});

test('宽预算仍限制长关联全文，但保留短关联全文', () => {
  const primary = unit('a', 0, 'excerpt', 1, 1, 'portable path absolute');
  const shortAnchor = unit('b', 1, 'excerpt', 1, 1, 'path');
  const shortFile = unit('b', 1, 'file', 1, 20, `path absolute ${'s'.repeat(2_000)}`);
  const longAnchor = unit('c', 2, 'excerpt', 40, 40, 'repository path absolute', 'support');
  const longFile = unit('c', 2, 'file', 1, 189, `show include exclude ${'l'.repeat(6_500)}`, 'support');
  const result = selectEvidence({ alternatives: [primary, shortAnchor, shortFile, longAnchor, longFile],
    query: 'show complete functions for portable path absolute; include exact literals; exclude tests',
    budget: { maxBytes: 40_960 }, costModel: { id: 'test-json', measure } });

  expect(result.units.map((item) => item.id)).toContain(shortFile.id);
  expect(result.units.map((item) => item.id)).toContain(longAnchor.id);
  expect(result.units.map((item) => item.id)).not.toContain(longFile.id);
});

test('同一来源部分重叠的行只计入并交付一次', () => {
  const first = unit('a', 0, 'excerpt', 1, 3, 'one\ntwo\nthree');
  const second = { ...unit('b', 1, 'excerpt', 3, 5, 'three\nfour\nfive'),
    source: { ...first.source, lineStart: 3, lineEnd: 5 } };
  const result = selectEvidence({ alternatives: [first, second], budget: { maxBytes: 4096 },
    costModel: { id: 'test-json', measure } });
  expect(result.units.map((item) => [item.source.lineStart, item.source.lineEnd, item.text])).toEqual([
    [1, 3, 'one\ntwo\nthree'], [4, 5, 'four\nfive'],
  ]);
});

test('完整文件升级覆盖同源提示片段时只交付全文一次', () => {
  const anchor = unit('a', 0, 'excerpt', 10, 10, 'hex digest');
  const file = unit('a', 0, 'file', 1, 25,
    Array.from({ length: 25 }, (_, index) => index === 9 ? 'hex digest' : `line ${index + 1}`).join('\n'));
  const hint = { ...unit('hint', 1, 'excerpt', 20, 20, 'line 20', 'support'),
    source: { ...anchor.source, lineStart: 20, lineEnd: 20 } };
  const result = selectEvidence({ alternatives: [anchor, file, hint], query: 'hex digest',
    budget: { maxBytes: 20_000 }, costModel: { id: 'test-json', measure } });

  expect(result.units.map((item) => item.id)).toEqual([file.id]);
});

test('三至五个独立主要目标在宽预算内不因候选位次丢失有用全文', () => {
  const terms = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  for (const count of [3, 5]) {
    for (const rotation of [0, 1]) {
      const ordered = [...terms.slice(rotation), ...terms.slice(0, rotation)].slice(0, count);
      const alternatives = ordered.flatMap((term, rank) => [
        unit(term, rank, 'excerpt', 10, 10, 'seed'),
        unit(term, rank, 'file', 1, 30, `seed ${term} ${'x'.repeat(5_500)}`),
      ]);
      const result = selectEvidence({ alternatives,
        query: terms.join(' '), budget: { maxBytes: 40_960 },
        costModel: { id: 'test-json', measure } });
      expect(result.units.map((item) => item.kind)).toEqual(Array.from({ length: count }, () => 'file'));
      expect(result.bytes).toBeLessThanOrEqual(40_960);
    }
  }
});

test('未点名的大文件不因一个额外查询词自动扩成全文', () => {
  const excerpt = unit('decoder', 0, 'excerpt', 5, 5, 'create decoder');
  const full = unit('decoder', 0, 'file', 1, 30,
    Array.from({ length: 30 }, (_, index) => index === 4
      ? `create decoder field validation ${'x'.repeat(180)}`
      : `line ${index + 1} ${'x'.repeat(180)}`).join('\n'));
  const result = selectEvidence({ alternatives: [excerpt, full],
    query: 'field validation single line', budget: { maxBytes: 20_000 },
    costModel: { id: 'test-json', measure } });

  expect(result.units.map((item) => item.kind)).toEqual(['excerpt']);
});

test('明确点名的实现文件即使没有新查询词也可在预算内扩成全文', () => {
  const excerpt = unit('graph', 0, 'excerpt', 5, 5, 'workspace graph diagnostic');
  const full = unit('graph', 0, 'file', 1, 30,
    Array.from({ length: 30 }, (_, index) => index === 4
      ? `workspace graph diagnostic ${'x'.repeat(180)}`
      : `line ${index + 1} ${'x'.repeat(180)}`).join('\n'));
  const result = selectEvidence({ alternatives: [excerpt, full],
    query: 'workspace graph diagnostic', budget: { maxBytes: 20_000 },
    costModel: { id: 'test-json', measure } });

  expect(result.units.map((item) => item.kind)).toEqual(['file']);
});

test('空证据与被省略证据都遵守固定响应成本预算', () => {
  const oversized = { id: 'fixed', measure: () => ({ bytes: 100 }) };
  expect(() => selectEvidence({ alternatives: [], budget: { maxBytes: 1 },
    costModel: oversized })).toThrowError(expect.objectContaining({ code: 'BUDGET_TOO_SMALL' }));
  const candidate = unit('a', 0, 'excerpt', 1, 1, '正文');
  const serialized = { id: 'utf8-json', measure };
  const emptyBytes = measure([]).bytes;
  const result = selectEvidence({ alternatives: [candidate], budget: { maxBytes: emptyBytes },
    costModel: serialized });
  expect(result.units).toEqual([]);
  expect(result.bytes).toBe(emptyBytes);
  expect(result.omittedCandidateIds).toEqual(['a']);
  expect(() => selectEvidence({ alternatives: [candidate], budget: { maxBytes: emptyBytes - 1 },
    costModel: serialized })).toThrowError(expect.objectContaining({ code: 'BUDGET_TOO_SMALL' }));
  const included = selectEvidence({ alternatives: [candidate], budget: { maxBytes: 4096 },
    costModel: serialized });
  expect(included.units).toEqual([candidate]);
  expect(included.bytes).toBe(measure([candidate]).bytes);
});
