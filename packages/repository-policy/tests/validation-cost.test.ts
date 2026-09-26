import { afterEach, describe, expect, it, vi } from 'vitest';

import { evaluatePolicyCondition, resolvePolicies } from '../src/index.js';
import { preparePolicyRepository } from '../src/node.js';
import { validateResolveRequest } from '../src/request.js';
import { withPolicyFixture } from './support/node-fixture.js';
import { sampleManifest, sampleRequest } from './support/sample.js';

vi.mock('../src/request.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/request.js')>();
  return {
    ...original,
    validateResolveRequest: vi.fn(original.validateResolveRequest),
  };
});

afterEach(() => vi.clearAllMocks());

describe('request validation work', () => {
  it('does not multiply full request validation by the policy count', () => {
    const policies = Array.from({ length: 64 }, (_, index) => ({
      id: `rule-${String(index).padStart(2, '0')}`,
      source: { path: 'rules/base.md' },
      when: { always: true as const },
      requires: [],
      conflictsWith: [],
      checkIds: [],
    }));
    const result = resolvePolicies({ ...sampleManifest, policies }, sampleRequest);

    expect(result.state).toBe('ready');
    expect(result.requiredIds).toEqual(policies.map((policy) => policy.id));
    expect(validateResolveRequest).toHaveBeenCalledTimes(1);
  });

  it('validates each prepared request once without revalidating it for every rule', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const bundle = await prepared.repository.resolve(sampleRequest);
      expect(bundle.deliveryComplete).toBe(true);
      expect(bundle.resolution.requiredIds).toEqual(['base']);
      expect(bundle.resolution.candidateIds).toEqual(['api']);
      expect(validateResolveRequest).toHaveBeenCalledTimes(1);
    });
  });

  it('still validates standalone conditions and rejects invalid public requests', () => {
    const invalid = {
      ...sampleRequest,
      facts: [{
        id: 'api-impact',
        state: 'true' as const,
        basis: 'verified' as const,
        contextId: sampleRequest.contextId,
        evidenceIds: [],
      }],
    };
    expect(() => evaluatePolicyCondition({ always: true }, invalid))
      .toThrow('Invalid resolve request');
    const resolution = resolvePolicies(sampleManifest, invalid);
    expect(resolution.state).toBe('invalid');
    expect(resolution.requiredIds).toEqual([]);
    expect(resolution.diagnostics.map((item) => item.code)).toContain('MISSING_EVIDENCE');
    expect(validateResolveRequest).toHaveBeenCalledTimes(2);
  });
});
