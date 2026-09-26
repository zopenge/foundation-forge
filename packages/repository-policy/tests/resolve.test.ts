import { describe, expect, it } from 'vitest';

import { resolvePolicies } from '../src/index.js';
import type {
  PolicyDefinition,
  PolicyManifest,
  ResolveRequest,
} from '../src/index.js';
import { sampleManifest, sampleRequest } from './support/sample.js';

const policy = (
  id: string,
  when: PolicyDefinition['when'],
  requires: readonly string[] = [],
  conflictsWith: readonly string[] = [],
): PolicyDefinition => ({
  id,
  source: { path: `rules/${id}.md` },
  when,
  requires,
  conflictsWith,
  checkIds: [],
});

const manifest = (
  policies: readonly PolicyDefinition[],
  factIds: readonly string[] = [],
): PolicyManifest => ({
  schemaVersion: 1,
  factIds,
  policies,
  checks: [],
});

describe('policy resolution', () => {
  it('keeps an uncertain rule as candidate with its dependency already required', () => {
    const beforeManifest = JSON.stringify(sampleManifest);
    const beforeRequest = JSON.stringify(sampleRequest);
    const result = resolvePolicies(sampleManifest, sampleRequest);

    expect(result.requiredIds).toEqual(['base']);
    expect(result.candidateIds).toEqual(['api']);
    expect(result.excludedIds).toEqual([]);
    expect(result.state).toBe('needs-context');
    expect(result.unresolvedFactIds).toEqual(['api-impact']);
    expect(result.unresolvedScope).toBe(false);
    expect(JSON.stringify(sampleManifest)).toBe(beforeManifest);
    expect(JSON.stringify(sampleRequest)).toBe(beforeRequest);
  });
  it('forces a required dependency even when its own condition is false', () => {
    const input = manifest([
      policy('base', { anyOf: [{ path: { prefixes: ['never/'] } }] }),
      policy('feature', { always: true }, ['base']),
    ]);
    const request: ResolveRequest = {
      ...sampleRequest,
      scope: { paths: [{ path: 'src/file.ts', role: 'write' }], complete: true },
    };
    const result = resolvePolicies(input, request);

    expect(result.requiredIds).toEqual(['base', 'feature']);
    expect(result.candidateIds).toEqual([]);
    expect(result.excludedIds).toEqual([]);
    expect(result.state).toBe('ready');
    expect(result.reasons).toContainEqual({
      policyId: 'base',
      kind: 'requires',
      fromId: 'feature',
      evidenceIds: [],
    });
  });

  it('upgrades a candidate dependency when a required policy requires it', () => {
    const input = manifest([
      policy('base', { always: true }),
      policy('api', { anyOf: [{ facts: [{ id: 'api-impact', equals: true }] }] }, ['base']),
      policy('ship', { always: true }, ['api']),
    ], ['api-impact']);
    const result = resolvePolicies(input, sampleRequest);

    expect(result.requiredIds).toEqual(['base', 'api', 'ship']);
    expect(result.candidateIds).toEqual([]);
    expect(result.state).toBe('ready');
  });
  it('keeps candidate dependencies conservative without overlapping required', () => {
    const input = manifest([
      policy('base', { anyOf: [{ facts: [{ id: 'base-impact', equals: true }] }] }),
      policy('feature', { anyOf: [{ facts: [{ id: 'feature-impact', equals: true }] }] }, ['base']),
    ], ['base-impact', 'feature-impact']);
    const result = resolvePolicies(input, sampleRequest);

    expect(result.requiredIds).toEqual([]);
    expect(result.candidateIds).toEqual(['base', 'feature']);
    expect(result.state).toBe('needs-context');
  });

  it('produces stable dependency-first topology for a diamond regardless of manifest order', () => {
    const definitions = [
      policy('a', { always: true }),
      policy('b', { always: true }, ['a']),
      policy('c', { always: true }, ['a']),
      policy('d', { always: true }, ['c', 'b']),
    ];
    expect(resolvePolicies(manifest(definitions), sampleRequest).requiredIds)
      .toEqual(['a', 'b', 'c', 'd']);
    expect(resolvePolicies(manifest([...definitions].reverse()), sampleRequest).requiredIds)
      .toEqual(['a', 'b', 'c', 'd']);
  });

  it('marks false conditions excluded only when they are not pulled into closure', () => {
    const input = manifest([
      policy('nope', { anyOf: [{ path: { prefixes: ['never/'] } }] }),
      policy('yes', { always: true }),
    ]);
    const request: ResolveRequest = {
      ...sampleRequest,
      scope: { paths: [{ path: 'src/file.ts', role: 'write' }], complete: true },
    };
    const result = resolvePolicies(input, request);
    expect(result.requiredIds).toEqual(['yes']);
    expect(result.candidateIds).toEqual([]);
    expect(result.excludedIds).toEqual(['nope']);
  });
  it('reports required-required conflict without selecting a winner', () => {
    const input = manifest([
      policy('a', { always: true }, [], ['b']),
      policy('b', { always: true }),
    ]);
    const result = resolvePolicies(input, sampleRequest);

    expect(result.state).toBe('conflict');
    expect(result.requiredIds).toEqual(['a', 'b']);
    expect(result.diagnostics.map((item) => item.code)).toContain('POLICY_CONFLICT');
  });

  it('reports required-candidate potential conflict as needs-context', () => {
    const input = manifest([
      policy('a', { always: true }, [], ['b']),
      policy('b', { anyOf: [{ facts: [{ id: 'impact', equals: true }] }] }),
    ], ['impact']);
    const result = resolvePolicies(input, sampleRequest);

    expect(result.state).toBe('needs-context');
    expect(result.requiredIds).toEqual(['a']);
    expect(result.candidateIds).toEqual(['b']);
    expect(result.diagnostics.map((item) => item.code)).toContain('POTENTIAL_CONFLICT');
  });

  it('reports candidate-candidate potential conflict as needs-context', () => {
    const input = manifest([
      policy('a', { anyOf: [{ facts: [{ id: 'a-impact', equals: true }] }] }, [], ['b']),
      policy('b', { anyOf: [{ facts: [{ id: 'b-impact', equals: true }] }] }),
    ], ['a-impact', 'b-impact']);
    const result = resolvePolicies(input, sampleRequest);

    expect(result.state).toBe('needs-context');
    expect(result.candidateIds).toEqual(['a', 'b']);
    expect(result.diagnostics.map((item) => item.code)).toContain('POTENTIAL_CONFLICT');
  });
  it('returns invalid without a partial usable resolution for an invalid manifest', () => {
    const invalid = {
      ...sampleManifest,
      policies: [...sampleManifest.policies, sampleManifest.policies[0]],
    };
    const result = resolvePolicies(invalid as PolicyManifest, sampleRequest);

    expect(result.state).toBe('invalid');
    expect(result.requiredIds).toEqual([]);
    expect(result.candidateIds).toEqual([]);
    expect(result.excludedIds).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('returns invalid for an invalid request instead of throwing or resolving partially', () => {
    const invalidRequest = {
      ...sampleRequest,
      facts: [
        {
          id: 'api-impact',
          state: 'unknown',
          basis: 'unknown',
          contextId: 'fixture-1',
          evidenceIds: [],
        },
        {
          id: 'api-impact',
          state: 'unknown',
          basis: 'unknown',
          contextId: 'fixture-1',
          evidenceIds: [],
        },
      ],
    } as ResolveRequest;
    const result = resolvePolicies(sampleManifest, invalidRequest);

    expect(result.state).toBe('invalid');
    expect(result.requiredIds).toEqual([]);
    expect(result.candidateIds).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('DUPLICATE_ID');
  });

  it('marks stale verified facts unresolved and emits STALE_FACT', () => {
    const request: ResolveRequest = {
      ...sampleRequest,
      facts: [{
        id: 'api-impact',
        state: 'true',
        basis: 'verified',
        contextId: 'older-context',
        evidenceIds: ['old-evidence'],
      }],
      evidence: [{
        id: 'old-evidence',
        contextId: 'older-context',
        sourceId: 'source-api',
        digest: 'old-digest',
      }],
    };
    const result = resolvePolicies(sampleManifest, request);

    expect(result.state).toBe('needs-context');
    expect(result.candidateIds).toEqual(['api']);
    expect(result.unresolvedFactIds).toEqual(['api-impact']);
    expect(result.diagnostics.map((item) => item.code)).toContain('STALE_FACT');
  });
  it('marks unresolvedScope only when an unknown path selector depends on incomplete scope', () => {
    const input = manifest([
      policy('path-rule', { anyOf: [{ path: { prefixes: ['src/a/'] } }] }),
    ]);
    const result = resolvePolicies(input, sampleRequest);

    expect(result.state).toBe('needs-context');
    expect(result.candidateIds).toEqual(['path-rule']);
    expect(result.unresolvedFactIds).toEqual([]);
    expect(result.unresolvedScope).toBe(true);
  });

  it('does not report unknown facts from an AND clause already made false', () => {
    const input = manifest([
      policy('mixed', {
        anyOf: [
          {
            path: { prefixes: ['never/'] },
            facts: [{ id: 'irrelevant', equals: true }],
          },
          { facts: [{ id: 'relevant', equals: true }] },
        ],
      }),
    ], ['irrelevant', 'relevant']);
    const request: ResolveRequest = {
      ...sampleRequest,
      scope: { paths: [{ path: 'src/file.ts', role: 'write' }], complete: true },
    };
    const result = resolvePolicies(input, request);

    expect(result.state).toBe('needs-context');
    expect(result.candidateIds).toEqual(['mixed']);
    expect(result.unresolvedFactIds).toEqual(['relevant']);
  });

  it('returns direct reason nodes and dependency edges without expanding every path', () => {
    const input = manifest([
      policy('base', { always: true }),
      policy('feature', { always: true }, ['base']),
    ]);
    const result = resolvePolicies(input, sampleRequest);

    expect(result.reasons).toContainEqual({
      policyId: 'feature',
      kind: 'always',
      fromId: null,
      evidenceIds: [],
    });
    expect(result.reasons).toContainEqual({
      policyId: 'base',
      kind: 'requires',
      fromId: 'feature',
      evidenceIds: [],
    });
    expect(result.reasons).toHaveLength(3);
  });
});
