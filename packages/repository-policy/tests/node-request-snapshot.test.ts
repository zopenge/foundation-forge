import { afterEach, describe, expect, it, vi } from 'vitest';

import { preparePolicyRepository, resolvePolicyBundle } from '../src/node.js';
import { withPolicyFixture } from './support/node-fixture.js';
import { sampleRequest } from './support/sample.js';

afterEach(() => vi.restoreAllMocks());

describe.each(['one-shot', 'prepared'] as const)('%s Node request snapshot', (entrypoint) => {
  it('rejects an accessor context without invoking caller code', async () => {
    await withPolicyFixture(async ({ options }) => {
      const getter = vi.fn(() => 'accessed-context');
      const input = Object.defineProperty({ ...sampleRequest }, 'contextId', {
        enumerable: true,
        get: getter,
      });
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = await (entrypoint === 'one-shot'
        ? resolvePolicyBundle({ ...options, request: input })
        : prepared.repository.resolve(input));

      expect(result.deliveryComplete).toBe(false);
      expect(result.bundleDigest).toBeNull();
      expect(result.diagnostics.map((item) => item.code)).toContain('INVALID_SCHEMA');
      expect(getter).not.toHaveBeenCalled();
    });
  });

  it('uses the same strict data snapshot for validation, resolution and identity', async () => {
    await withPolicyFixture(async ({ options }) => {
      const input = new Proxy({ ...sampleRequest }, {
        get: () => { throw new Error('Caller input was read again'); },
      });
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = await (entrypoint === 'one-shot'
        ? resolvePolicyBundle({ ...options, request: input })
        : prepared.repository.resolve(input));

      expect(result.deliveryComplete).toBe(true);
      expect(result.bundleDigest).toBe('0a24f2fe097504505db8ba5ca769c9733a2e945e454f37cb468f12cf1abf1f83');
      expect(result.documents.map((document) => document.text)).toEqual(['api\n', 'base\n']);
    });
  });

  it('retains the strict snapshot without making a second full request clone', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const clone = vi.spyOn(globalThis, 'structuredClone');
      const result = await (entrypoint === 'one-shot'
        ? resolvePolicyBundle(options)
        : prepared.repository.resolve(sampleRequest));
      const requestCopies = clone.mock.calls.filter(([value]) => (
        typeof value === 'object' && value !== null && 'contextId' in value
      )).length;
      clone.mockRestore();

      expect(result.deliveryComplete).toBe(true);
      expect(result.bundleDigest).toBe('0a24f2fe097504505db8ba5ca769c9733a2e945e454f37cb468f12cf1abf1f83');
      expect(requestCopies).toBe(0);
    });
  });

  it('does not discard an unknown prototype-named field during strict snapshotting', async () => {
    await withPolicyFixture(async ({ options }) => {
      const input = JSON.parse(JSON.stringify(sampleRequest).replace(/}$/, ',"__proto__":{"hidden":true}}'));
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = await (entrypoint === 'one-shot'
        ? resolvePolicyBundle({ ...options, request: input })
        : prepared.repository.resolve(input));

      expect(result.deliveryComplete).toBe(false);
      expect(result.bundleDigest).toBeNull();
      expect(result.diagnostics).toEqual([{
        code: 'UNKNOWN_FIELD', severity: 'error', policyIds: [], fieldPath: '__proto__', relatedIds: [],
      }]);
    });
  });

  it('preserves unknown-field diagnostics in the original nested insertion order', async () => {
    await withPolicyFixture(async ({ options }) => {
      const input = {
        ...sampleRequest,
        zzz: true,
        aaa: true,
        scope: { ...sampleRequest.scope, zzz: true, aaa: true },
      };
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const result = await (entrypoint === 'one-shot'
        ? resolvePolicyBundle({ ...options, request: input })
        : prepared.repository.resolve(input));

      expect(result.deliveryComplete).toBe(false);
      expect(result.bundleDigest).toBeNull();
      expect(result.diagnostics).toEqual(['zzz', 'aaa', 'scope.zzz', 'scope.aaa'].map((fieldPath) => ({
        code: 'UNKNOWN_FIELD', severity: 'error', policyIds: [], fieldPath, relatedIds: [],
      })));
    });
  });
});
