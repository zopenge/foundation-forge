import { afterEach, describe, expect, it, vi } from 'vitest';

import { evaluatePolicyConditionDetails } from '../src/conditions.js';
import type { ResolveRequest, Truth } from '../src/contracts.js';
import { sampleRequest } from './support/sample.js';

afterEach(() => vi.restoreAllMocks());

const requestFor = (values: readonly Truth[]): ResolveRequest => ({
  ...sampleRequest,
  facts: values.map((state, index) => ({
    id: index === 0 ? 'a' : 'b',
    state,
    basis: state === 'unknown' ? 'unknown' : 'verified',
    contextId: sampleRequest.contextId,
    evidenceIds: state === 'unknown' ? [] : [`e${index}`],
  })),
  evidence: values.flatMap((state, index) => state === 'unknown' ? [] : [{
    id: `e${index}`,
    contextId: sampleRequest.contextId,
    sourceId: `s${index}`,
    digest: `d${index}`,
  }]),
});

const truthTable = [
  ['true', 'true', 'true', ['a', 'b'], 'true', ['a', 'b']],
  ['true', 'false', 'false', ['b'], 'true', ['a']],
  ['true', 'unknown', 'unknown', ['a', 'b'], 'true', ['a']],
  ['false', 'true', 'false', ['a'], 'true', ['b']],
  ['false', 'false', 'false', ['a', 'b'], 'false', ['a', 'b']],
  ['false', 'unknown', 'false', ['a'], 'unknown', ['b']],
  ['unknown', 'true', 'unknown', ['a', 'b'], 'true', ['b']],
  ['unknown', 'false', 'false', ['b'], 'unknown', ['a']],
  ['unknown', 'unknown', 'unknown', ['a', 'b'], 'unknown', ['a', 'b']],
] as const;

describe('condition explanation semantics and allocation', () => {
  it.each(['true', 'false', 'unknown'] as const)(
    'preserves a single %s fact explanation without copying combination arrays',
    (state) => {
      const request = requestFor([state]);
      const flatMap = vi.spyOn(Array.prototype, 'flatMap');
      const result = evaluatePolicyConditionDetails({
        anyOf: [{ facts: [{ id: 'a', equals: true }] }],
      }, request);
      // 观察真实数组扁平化调用，不替换规则结果或校验行为。
      const copiedGroups = flatMap.mock.contexts.filter((context) => (
        Array.isArray(context)
        && context.some((value: unknown) => (
          typeof value === 'object' && value !== null && 'truth' in value
        ))
      )).length;
      flatMap.mockRestore();

      expect(result).toEqual({
        truth: state,
        unresolvedFactIds: state === 'unknown' ? ['a'] : [],
        unresolvedScope: false,
        reasons: [{
          kind: state === 'unknown' ? 'unknown' : 'fact',
          fromId: 'a',
          evidenceIds: state === 'unknown' ? [] : ['e0'],
        }],
      });
      expect(copiedGroups).toBe(0);
    },
  );

  it.each(truthTable)(
    'retains AND/OR reason relevance for %s and %s',
    (left, right, andTruth, andIds, orTruth, orIds) => {
      const request = requestFor([left, right]);
      const predicates = [{ id: 'a', equals: true }, { id: 'b', equals: true }];
      for (const [condition, truth, ids] of [
        [{ anyOf: [{ facts: predicates }] }, andTruth, andIds],
        [{ anyOf: predicates.map((predicate) => ({ facts: [predicate] })) }, orTruth, orIds],
      ] as const) {
        const result = evaluatePolicyConditionDetails(condition, request);
        expect(result.truth).toBe(truth);
        expect(result.reasons.map((reason) => reason.fromId)).toEqual(ids);
        expect(result.unresolvedScope).toBe(false);
        expect(result.unresolvedFactIds).toEqual(truth === 'unknown'
          ? ids.filter((id) => (id === 'a' ? left : right) === 'unknown')
          : []);
      }
    },
  );

  it('deduplicates unresolved facts while retaining repeated reasons in clause order', () => {
    const result = evaluatePolicyConditionDetails({
      anyOf: [{ facts: [
        { id: 'b', equals: true },
        { id: 'a', equals: true },
        { id: 'b', equals: false },
      ] }],
    }, requestFor(['unknown', 'unknown']));

    expect(result.truth).toBe('unknown');
    expect(result.unresolvedFactIds).toEqual(['a', 'b']);
    expect(result.reasons.map((reason) => reason.fromId)).toEqual(['b', 'a', 'b']);
  });

  it('keeps stale facts unknown and observes a changed request on each call', () => {
    const condition = { anyOf: [{ facts: [{ id: 'a', equals: true }] }] } as const;
    const current = requestFor(['true']);
    const stale = {
      ...current,
      facts: current.facts.map((fact) => ({ ...fact, contextId: 'older-context' })),
      evidence: current.evidence.map((item) => ({ ...item, contextId: 'older-context' })),
    };
    expect(evaluatePolicyConditionDetails(condition, current).truth).toBe('true');
    const result = evaluatePolicyConditionDetails(condition, stale);
    expect(result.truth).toBe('unknown');
    expect(result.unresolvedFactIds).toEqual(['a']);
    expect(result.reasons).toEqual([{ kind: 'unknown', fromId: 'a', evidenceIds: ['e0'] }]);
  });
});
