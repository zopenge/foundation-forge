import { describe, expect, it } from 'vitest';

import { evaluatePolicyCondition } from '../src/index.js';
import type { ResolveRequest } from '../src/index.js';
import { sampleRequest } from './support/sample.js';

const request = (overrides: Partial<ResolveRequest>): ResolveRequest => ({
  ...sampleRequest,
  ...overrides,
});

describe('policy condition evaluation', () => {
  it('evaluates always to true', () => {
    expect(evaluatePolicyCondition({ always: true }, sampleRequest)).toBe('true');
  });

  it('does not match sibling directory prefixes', () => {
    const condition = { anyOf: [{ path: { prefixes: ['src/a/'] } }] } as const;
    expect(evaluatePolicyCondition(condition, request({
      scope: { paths: [{ path: 'src/abc/x.ts', role: 'write' }], complete: false },
    }))).toBe('unknown');
    expect(evaluatePolicyCondition(condition, request({
      scope: { paths: [{ path: 'src/abc/x.ts', role: 'write' }], complete: true },
    }))).toBe('false');
  });
  it('requires all path selector terms on the same evidence row', () => {
    const condition = {
      anyOf: [{
        path: {
          prefixes: ['src/a/'],
          extensions: ['.ts'],
          roles: ['write'],
        },
      }],
    } as const;
    expect(evaluatePolicyCondition(condition, request({
      scope: {
        paths: [
          { path: 'src/a/file.js', role: 'write' },
          { path: 'src/b/file.ts', role: 'write' },
        ],
        complete: true,
      },
    }))).toBe('false');
    expect(evaluatePolicyCondition(condition, request({
      scope: { paths: [{ path: 'src/a/file.ts', role: 'write' }], complete: true },
    }))).toBe('true');
  });
  it('keeps suggested and missing facts unknown', () => {
    const condition = {
      anyOf: [{ facts: [{ id: 'api-impact', equals: true }] }],
    } as const;
    expect(evaluatePolicyCondition(condition, request({
      facts: [{
        id: 'api-impact',
        state: 'false',
        basis: 'suggested',
        contextId: 'fixture-1',
        evidenceIds: [],
      }],
    }))).toBe('unknown');
    expect(evaluatePolicyCondition(condition, sampleRequest)).toBe('unknown');
  });

  it('treats stale verified facts as unknown', () => {
    const condition = {
      anyOf: [{ facts: [{ id: 'api-impact', equals: true }] }],
    } as const;
    expect(evaluatePolicyCondition(condition, request({
      facts: [{
        id: 'api-impact',
        state: 'true',
        basis: 'verified',
        contextId: 'older-context',
        evidenceIds: ['evidence-1'],
      }],
      evidence: [{
        id: 'evidence-1',
        contextId: 'older-context',
        sourceId: 'source-1',
        digest: 'fixture',
      }],
    }))).toBe('unknown');
  });

  it('uses verified false as evidence for equals false', () => {
    const condition = {
      anyOf: [{ facts: [{ id: 'api-impact', equals: false }] }],
    } as const;
    expect(evaluatePolicyCondition(condition, request({
      facts: [{
        id: 'api-impact',
        state: 'false',
        basis: 'verified',
        contextId: 'fixture-1',
        evidenceIds: ['evidence-1'],
      }],
      evidence: [{
        id: 'evidence-1',
        contextId: 'fixture-1',
        sourceId: 'source-1',
        digest: 'fixture',
      }],
    }))).toBe('true');
  });

  it('implements three-state OR without erasing unknown', () => {
    const condition = {
      anyOf: [
        { path: { prefixes: ['missing/'] } },
        { facts: [{ id: 'api-impact', equals: true }] },
      ],
    } as const;
    expect(evaluatePolicyCondition(condition, request({
      scope: { paths: [{ path: 'src/a.ts', role: 'write' }], complete: true },
      facts: [],
    }))).toBe('unknown');
  });

  it('is monotonic when an incomplete scope gains a matching path', () => {
    const condition = { anyOf: [{ path: { prefixes: ['src/a/'] } }] } as const;
    const scopes: ResolveRequest['scope'][] = [
      { paths: [], complete: false },
      { paths: [{ path: 'src/b/file.ts', role: 'write' }], complete: false },
      {
        paths: [
          { path: 'src/b/file.ts', role: 'write' },
          { path: 'src/a/file.ts', role: 'write' },
        ],
        complete: false,
      },
    ];
    expect(scopes.map((scope) => (
      evaluatePolicyCondition(condition, request({ scope }))
    ))).toEqual(['unknown', 'unknown', 'true']);
  });
});

const truthValues = ['true', 'false', 'unknown'] as const;

const expectedAnd = (left: typeof truthValues[number], right: typeof truthValues[number]) => {
  if (left === 'false' || right === 'false') return 'false';
  if (left === 'true' && right === 'true') return 'true';
  return 'unknown';
};

const expectedOr = (left: typeof truthValues[number], right: typeof truthValues[number]) => {
  if (left === 'true' || right === 'true') return 'true';
  if (left === 'false' && right === 'false') return 'false';
  return 'unknown';
};

const factValue = (
  id: string,
  value: typeof truthValues[number],
) => {
  if (value === 'unknown') {
    return {
      fact: {
        id,
        state: 'unknown',
        basis: 'unknown',
        contextId: 'fixture-1',
        evidenceIds: [],
      } as const,
      evidence: [],
    };
  }
  const evidenceId = `evidence-${id}`;
  return {
    fact: {
      id,
      state: value,
      basis: 'verified',
      contextId: 'fixture-1',
      evidenceIds: [evidenceId],
    } as const,
    evidence: [{
      id: evidenceId,
      contextId: 'fixture-1',
      sourceId: `source-${id}`,
      digest: `digest-${id}`,
    }],
  };
};

describe('three-state algebra and deterministic properties', () => {
  it.each(
    truthValues.flatMap((left) => truthValues.map((right) => [left, right] as const)),
  )('implements AND truth table for %s/%s', (left, right) => {
    const a = factValue('a', left);
    const b = factValue('b', right);
    const result = evaluatePolicyCondition({
      anyOf: [{ facts: [{ id: 'a', equals: true }, { id: 'b', equals: true }] }],
    }, request({
      facts: [a.fact, b.fact],
      evidence: [...a.evidence, ...b.evidence],
    }));
    expect(result).toBe(expectedAnd(left, right));
  });

  it.each(
    truthValues.flatMap((left) => truthValues.map((right) => [left, right] as const)),
  )('implements OR truth table for %s/%s', (left, right) => {
    const a = factValue('a', left);
    const b = factValue('b', right);
    const result = evaluatePolicyCondition({
      anyOf: [
        { facts: [{ id: 'a', equals: true }] },
        { facts: [{ id: 'b', equals: true }] },
      ],
    }, request({
      facts: [a.fact, b.fact],
      evidence: [...a.evidence, ...b.evidence],
    }));
    expect(result).toBe(expectedOr(left, right));
  });

  it('is invariant under fixed-seed request input permutations', () => {
    let seed = 0x5eed1234;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const shuffle = <T>(values: readonly T[]): T[] => {
      const output = [...values];
      for (let index = output.length - 1; index > 0; index -= 1) {
        const target = next() % (index + 1);
        const current = output[index];
        const replacement = output[target];
        if (current === undefined || replacement === undefined) {
          throw new Error('shuffle index must remain within bounds');
        }
        output[index] = replacement;
        output[target] = current;
      }
      return output;
    };

    const condition = {
      anyOf: [{
        path: {
          prefixes: ['src/a/'],
          extensions: ['.ts'],
          roles: ['write'],
        },
        facts: [{ id: 'api-impact', equals: true }],
      }],
    } as const;
    const baseFacts = [
      {
        id: 'api-impact',
        state: 'true',
        basis: 'verified',
        contextId: 'fixture-1',
        evidenceIds: ['evidence-api'],
      },
      {
        id: 'other-impact',
        state: 'unknown',
        basis: 'unknown',
        contextId: 'fixture-1',
        evidenceIds: [],
      },
    ] as const;
    const baseEvidence = [{
      id: 'evidence-api',
      contextId: 'fixture-1',
      sourceId: 'source-api',
      digest: 'digest-api',
    }] as const;
    const basePaths = [
      { path: 'src/b/other.ts', role: 'write' },
      { path: 'src/a/read.ts', role: 'read' },
      { path: 'src/a/match.ts', role: 'write' },
    ] as const;

    for (let attempt = 0; attempt < 32; attempt += 1) {
      expect(evaluatePolicyCondition(condition, request({
        scope: { paths: shuffle(basePaths), complete: false },
        facts: shuffle(baseFacts),
        evidence: shuffle(baseEvidence),
      }))).toBe('true');
    }
  });

  it('never turns incomplete non-matches false before a fixed-seed matching expansion', () => {
    let seed = 0x1234abcd;
    const randomSegment = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed % 100000).toString(36);
    };
    const condition = { anyOf: [{ path: { prefixes: ['src/target/'] } }] } as const;
    const paths = Array.from({ length: 24 }, () => ({
      path: `src/other/${randomSegment()}.ts`,
      role: 'write' as const,
    }));
    expect(evaluatePolicyCondition(condition, request({
      scope: { paths, complete: false },
    }))).toBe('unknown');
    expect(evaluatePolicyCondition(condition, request({
      scope: {
        paths: [...paths, { path: 'src/target/file.ts', role: 'write' }],
        complete: false,
      },
    }))).toBe('true');
  });
});
