import { stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePolicyBundle } from '../src/node.js';
import { sampleManifest, sampleRequest } from './support/sample.js';
import { withPolicyFixture } from './support/node-fixture.js';

describe('Node policy identity', () => {
  it('changes bundle identity when source text changes', async () => {
    await withPolicyFixture(async ({ options, write }) => {
      const first = await resolvePolicyBundle(options);
      await write('rules/base.md', 'base changed\n');
      const next = await resolvePolicyBundle(options);
      expect(next.bundleDigest).not.toBe(first.bundleDigest);
      expect(
        next.documents.find((item) => item.source.path === 'rules/base.md')?.text,
      ).toBe('base changed\n');
    });
  });

  it('does not trust restored size and mtime over source content', async () => {
    await withPolicyFixture(async ({ root, options, write }) => {
      const target = join(root, 'rules', 'base.md');
      await write('rules/base.md', 'AAAA\n');
      const beforeMetadata = await stat(target);
      const first = await resolvePolicyBundle(options);
      await write('rules/base.md', 'BBBB\n');
      await utimes(target, beforeMetadata.atime, beforeMetadata.mtime);
      const second = await resolvePolicyBundle(options);
      expect(second.bundleDigest).not.toBe(first.bundleDigest);
    });
  });
  it('is stable across manifest object-key and set-like array reordering', async () => {
    await withPolicyFixture(async ({ options, write }) => {
      const first = await resolvePolicyBundle(options);
      const reversed = {
        checks: [...sampleManifest.checks].reverse(),
        policies: [...sampleManifest.policies]
          .reverse()
          .map((item) => ({
            checkIds: [...item.checkIds].reverse(),
            conflictsWith: [...item.conflictsWith].reverse(),
            requires: [...item.requires].reverse(),
            when: item.when,
            source: item.source,
            id: item.id,
          })),
        factIds: [...sampleManifest.factIds].reverse(),
        schemaVersion: 1,
      };
      await write('.forge/repository-policy.json', JSON.stringify(reversed));
      const second = await resolvePolicyBundle(options);
      expect(second.bundleDigest).toBe(first.bundleDigest);
    });
  });

  it('is stable across request object-key and path ordering', async () => {
    await withPolicyFixture(async ({ options }) => {
      const firstRequest = {
        ...sampleRequest,
        scope: {
          paths: [
            { path: 'src/b.ts', role: 'read' as const },
            { path: 'src/a.ts', role: 'write' as const },
          ],
          complete: false,
        },
      };
      const secondRequest = {
        evidence: sampleRequest.evidence,
        facts: sampleRequest.facts,
        scope: {
          complete: false,
          paths: [...firstRequest.scope.paths].reverse(),
        },
        contextId: sampleRequest.contextId,
        schemaVersion: 1 as const,
      };
      const first = await resolvePolicyBundle({ ...options, request: firstRequest });
      const second = await resolvePolicyBundle({ ...options, request: secondRequest });
      expect(second.bundleDigest).toBe(first.bundleDigest);
    });
  });
  it('enforces request byte limits before reading missing policy sources', async () => {
    await withPolicyFixture(async ({ options, remove }) => {
      await remove('rules/base.md');
      const bundle = await resolvePolicyBundle({
        ...options,
        limits: { requestBytes: 8 },
      });
      const codes = bundle.diagnostics.map((item) => item.code);
      expect(codes).toContain('INPUT_LIMIT');
      expect(codes).not.toContain('SOURCE_MISSING');
      expect(bundle.documents).toEqual([]);
    });
  });
});
