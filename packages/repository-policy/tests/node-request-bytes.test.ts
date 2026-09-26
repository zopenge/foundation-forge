import { cloneJsonValue } from '@openge/forge-deterministic-json';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { preparePolicyRepository, resolvePolicyBundle } from '../src/node.js';
import { snapshotRequest } from '../src/node/identity.js';
import { withPolicyFixture } from './support/node-fixture.js';
import { sampleRequest } from './support/sample.js';

vi.mock('@openge/forge-deterministic-json', async (importOriginal) => {
  const original = await importOriginal<typeof import('@openge/forge-deterministic-json')>();
  return {
    ...original,
    cloneJsonValue: vi.fn(original.cloneJsonValue),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const invalidJsonCases: readonly {
  readonly name: string;
  readonly create: (onAccess: () => void) => unknown;
}[] = [
  { name: 'undefined', create: () => undefined },
  { name: 'non-finite number', create: () => ({ value: Number.NaN }) },
  { name: 'bigint', create: () => ({ value: 1n }) },
  { name: 'sparse array', create: () => new Array<unknown>(2) },
  { name: 'array with extra fields', create: () => Object.assign([], { extra: true }) },
  { name: 'symbol key', create: () => ({ [Symbol('hidden')]: true }) },
  {
    name: 'custom prototype',
    create: () => {
      const value = { ...sampleRequest };
      Object.setPrototypeOf(value, { inherited: true });
      return value;
    },
  },
  {
    name: 'non-enumerable field',
    create: () => Object.defineProperty({ ...sampleRequest }, 'hidden', { value: true }),
  },
  {
    name: 'cycle',
    create: () => {
      const value: { self?: unknown } = {};
      value.self = value;
      return value;
    },
  },
  {
    name: 'accessor',
    create: (onAccess) => Object.defineProperty({ ...sampleRequest }, 'contextId', {
      enumerable: true,
      get: () => {
        onAccess();
        return 'accessed';
      },
    }),
  },
  {
    name: 'toJSON function',
    create: (onAccess) => ({
      ...sampleRequest,
      toJSON: () => {
        onAccess();
        return sampleRequest;
      },
    }),
  },
];

describe('Node request byte limits', () => {
  it('keeps strict serialization without allocating encoded bytes just to count them', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');

    expect(snapshotRequest(sampleRequest)?.byteLength).toBe(106);
    expect(cloneJsonValue).toHaveBeenCalledExactlyOnceWith(sampleRequest);
    expect(encode).not.toHaveBeenCalled();
  });

  it.each([
    ['a', 98],
    ['中文', 103],
    ['😀', 101],
    ['"\\\n\t\u0000', 111],
    ['\ud800', 103],
    ['\udfff', 103],
    ['边界"\\\n😀\ud800', 119],
  ] as const)('preserves the strict JSON byte count for %j', (contextId, expectedBytes) => {
    expect(snapshotRequest({ ...sampleRequest, contextId })?.byteLength).toBe(expectedBytes);
  });

  it.each(invalidJsonCases)('preserves null for invalid JSON: $name', ({ create }) => {
    const onAccess = vi.fn();
    const input = create(onAccess);

    expect(snapshotRequest(input)).toBeNull();
    expect(cloneJsonValue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cloneJsonValue).mock.calls[0]?.[0]).toBe(input);
    expect(onAccess).not.toHaveBeenCalled();
  });

  it.each(['one-shot', 'prepared'] as const)(
    'enforces the exact multibyte request limit through the %s API',
    async (entrypoint) => {
      await withPolicyFixture(async ({ options }) => {
        const request = { ...sampleRequest, contextId: '边界"\\\n😀\ud800' };
        const resolveAtLimit = async (requestBytes: number) => {
          const limited = { ...options, request, limits: { requestBytes } };
          if (entrypoint === 'one-shot') return resolvePolicyBundle(limited);
          const prepared = await preparePolicyRepository(limited);
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) throw new Error('fixture preparation failed');
          return prepared.repository.resolve(request);
        };

        const exact = await resolveAtLimit(119);
        expect(exact.deliveryComplete).toBe(true);
        expect(exact.bundleDigest).not.toBeNull();

        const overLimit = await resolveAtLimit(118);
        expect(overLimit.deliveryComplete).toBe(false);
        expect(overLimit.bundleDigest).toBeNull();
        expect(overLimit.documents).toEqual([]);
        expect(overLimit.diagnostics.map((item) => item.code)).toContain('INPUT_LIMIT');
      });
    },
  );
});
