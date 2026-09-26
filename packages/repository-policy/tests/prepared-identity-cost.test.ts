import { cloneJsonValue, stringifyDeterministicJson } from '@openge/forge-deterministic-json';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolveRequest } from '../src/contracts.js';
import { preparePolicyRepository, resolvePolicyBundle } from '../src/node.js';
import { withPolicyFixture } from './support/node-fixture.js';
import { sampleRequest } from './support/sample.js';

vi.mock('@openge/forge-deterministic-json', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openge/forge-deterministic-json')>();
  return {
    ...original,
    cloneJsonValue: vi.fn(original.cloneJsonValue),
    stringifyDeterministicJson: vi.fn(original.stringifyDeterministicJson),
  };
});

afterEach(() => vi.clearAllMocks());

const manifestSerializations = (): number => (
  vi.mocked(stringifyDeterministicJson).mock.calls.filter(([value]) => (
    typeof value === 'object'
    && value !== null
    && ('manifest' in value || 'policies' in value)
  )).length
);

describe('prepared bundle identity work', () => {
  it('reuses the fixed manifest identity while preserving v1 digests for changed requests', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const first = await prepared.repository.resolve(sampleRequest);
      expect(first.bundleDigest).toBe('0a24f2fe097504505db8ba5ca769c9733a2e945e454f37cb468f12cf1abf1f83');
      const firstWork = manifestSerializations();
      expect(firstWork).toBeGreaterThan(0);

      const changedRequest = { ...sampleRequest, contextId: 'changed-context' };
      const second = await prepared.repository.resolve(changedRequest);
      expect(second.deliveryComplete).toBe(true);
      expect(second.bundleDigest).not.toBe(first.bundleDigest);
      expect(manifestSerializations()).toBe(firstWork);
      const fresh = await resolvePolicyBundle({ ...options, request: changedRequest });
      expect(second).toEqual(fresh);
    });
  });

  it('retains strict request JSON validation before any prepared resolution', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const toJSON = vi.fn(() => sampleRequest);
      const request = { ...sampleRequest, toJSON };
      const result = await prepared.repository.resolve(request);

      expect(result.deliveryComplete).toBe(false);
      expect(result.bundleDigest).toBeNull();
      expect(result.documents).toEqual([]);
      expect(result.diagnostics.map((item) => item.code)).toContain('INVALID_SCHEMA');
      expect(toJSON).not.toHaveBeenCalled();
    });
  });

  it('performs strict JSON traversal only at the request boundary after preparation', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      vi.mocked(stringifyDeterministicJson).mockClear();
      vi.mocked(cloneJsonValue).mockClear();

      const result = await prepared.repository.resolve(sampleRequest);

      expect(result.deliveryComplete).toBe(true);
      expect(result.bundleDigest).toBe('0a24f2fe097504505db8ba5ca769c9733a2e945e454f37cb468f12cf1abf1f83');
      expect(cloneJsonValue).toHaveBeenCalledExactlyOnceWith(sampleRequest);
      expect(stringifyDeterministicJson).not.toHaveBeenCalled();
    });
  });

  it('preserves the v1 identity of full requests with escaped strings and reordered sets', async () => {
    await withPolicyFixture(async ({ options }) => {
      const contextId = 'fixture-"\\\n中文😀\ud800';
      const request: ResolveRequest = {
        schemaVersion: 1,
        contextId,
        scope: {
          paths: [
            { path: 'src/中文.ts', role: 'write' },
            { path: 'src/a.ts', role: 'impact' },
            { path: 'src/a.ts', role: 'read' },
          ],
          complete: true,
        },
        facts: [{
          id: 'api-impact',
          state: 'true',
          basis: 'verified',
          contextId,
          evidenceIds: ['e.z', 'e.a'],
        }],
        evidence: [
          { id: 'e.z', contextId, sourceId: 'source.z', digest: 'digest:"\\\n中文😀\ud800' },
          { id: 'e.a', contextId, sourceId: 'source.a', digest: 'digest.a' },
        ],
      };
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const expectedDigest = 'b76b01f02889e6ae2dba64090f98399997b8f4651350407462f8b80713ea49f0';
      const first = await prepared.repository.resolve(request);
      expect(first.deliveryComplete).toBe(true);
      expect(first.bundleDigest).toBe(expectedDigest);

      const reordered: ResolveRequest = {
        ...request,
        scope: { ...request.scope, paths: [...request.scope.paths].reverse() },
        facts: request.facts.map((fact) => ({ ...fact, evidenceIds: [...fact.evidenceIds].reverse() })),
        evidence: [...request.evidence].reverse(),
      };
      const second = await prepared.repository.resolve(reordered);
      expect(second.bundleDigest).toBe(expectedDigest);
      const fresh = await resolvePolicyBundle({ ...options, request: reordered });
      expect(fresh).toEqual(second);
    });
  });
});
