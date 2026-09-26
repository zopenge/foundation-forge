import { describe, expect, it } from 'vitest';

import {
  checkPolicyRepository,
  preparePolicyRepository,
  resolvePolicyBundle,
} from '../src/node.js';
import { sampleRequest } from './support/sample.js';
import { withPolicyFixture } from './support/node-fixture.js';

describe('Node asynchronous input identity', () => {
  it.each(['fresh', 'prepared'] as const)(
    'captures the %s request before asynchronous reads',
    async (mode) => {
      await withPolicyFixture(async ({ options }) => {
        const prepared = await preparePolicyRepository(options);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) return;
        const request = {
          ...structuredClone(sampleRequest),
          scope: { paths: [], complete: false },
        };
        const pending = mode === 'fresh'
          ? resolvePolicyBundle({ ...options, request })
          : prepared.repository.resolve(request);
        request.contextId = 'changed-after-call';
        request.scope.complete = true;
        const bundle = await pending;
        const original = await resolvePolicyBundle(options);
        expect(bundle.deliveryComplete).toBe(true);
        expect(bundle.resolution.contextId).toBe('fixture-1');
        expect(bundle.bundleDigest).toBe(original.bundleDigest);
      });
    },
  );

  it('keeps a one-shot resolution inside its original root', async () => {
    await withPolicyFixture(async ({ options }) => {
      await withPolicyFixture(async (other) => {
        await other.write('rules/base.md', 'other repository\n');
        const mutable = { ...options };
        const pending = resolvePolicyBundle(mutable);
        mutable.root = other.root;
        const bundle = await pending;
        expect(bundle.deliveryComplete).toBe(true);
        expect(bundle.documents.find(
          (item) => item.source.path === 'rules/base.md',
        )?.text).toBe('base\n');
      });
    });
  });

  it('keeps a repository check inside its original root', async () => {
    await withPolicyFixture(async ({ options }) => {
      await withPolicyFixture(async (other) => {
        await other.remove('rules/base.md');
        const mutable = { ...options };
        const pending = checkPolicyRepository(mutable);
        mutable.root = other.root;
        expect((await pending).state).toBe('passed');
      });
    });
  });
});
