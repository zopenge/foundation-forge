import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePolicyBundle } from '../src/node.js';
import { inspectRepositoryFile, readPolicySource } from '../src/node/read-sources.js';
import { sampleManifest } from './support/sample.js';
import { withPolicyFixture } from './support/node-fixture.js';

const codes = (diagnostics: readonly { readonly code: string }[]) => (
  diagnostics.map((diagnostic) => diagnostic.code)
);

describe('Node policy sources', () => {
  it('rejects a size change after the total-budget preflight', async () => {
    await withPolicyFixture(async ({ root, write }) => {
      const inspected = await inspectRepositoryFile(root, 'rules/base.md', 1024);
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      await write('rules/base.md', 'larger than the reserved byte budget\n');
      const result = await readPolicySource(
        root,
        { path: 'rules/base.md' },
        ['base'],
        1024,
        {},
        inspected.value,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostic.code).toBe('SOURCE_CHANGED');
    });
  });

  it('returns complete selected source text and content identity', async () => {
    await withPolicyFixture(async ({ options }) => {
      const bundle = await resolvePolicyBundle(options);
      expect(bundle.deliveryComplete).toBe(true);
      expect(bundle.bundleDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(bundle.documents.map((item) => item.source.path)).toEqual([
        'rules/api.md',
        'rules/base.md',
      ]);
      expect(bundle.documents.every((item) => item.text !== null)).toBe(true);
      expect(bundle.documents.every((item) => /^[0-9a-f]{64}$/u.test(item.sha256))).toBe(true);
    });
  });
  it('preserves source BOM, CRLF and readable Chinese while hashing raw bytes', async () => {
    await withPolicyFixture(async ({ options, writeBytes }) => {
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('基础\r\n', 'utf8'),
      ]);
      await writeBytes('rules/base.md', bytes);
      const bundle = await resolvePolicyBundle(options);
      const document = bundle.documents.find((item) => item.source.path === 'rules/base.md');
      expect(document?.text).toBe('\ufeff基础\r\n');
      expect(document?.utf8Bytes).toBe(bytes.byteLength);
    });
  });

  it('rejects invalid UTF-8 and U+FFFD source text', async () => {
    await withPolicyFixture(async ({ options, writeBytes, write }) => {
      await writeBytes('rules/base.md', Uint8Array.from([0xff]));
      const invalidBytes = await resolvePolicyBundle(options);
      expect(invalidBytes.deliveryComplete).toBe(false);
      expect(invalidBytes.bundleDigest).toBeNull();
      expect(codes(invalidBytes.diagnostics)).toContain('INVALID_UTF8');

      await write('rules/base.md', 'bad \ufffd text');
      const replacement = await resolvePolicyBundle(options);
      expect(codes(replacement.diagnostics)).toContain('INVALID_UTF8');
    });
  });
  it('blocks a junction that resolves outside the repository root', async () => {
    await withPolicyFixture(async ({ root, options, write }) => {
      const outside = await mkdtemp(join(dirname(root), 'outside-'));
      try {
        await writeFile(join(outside, 'outside.md'), 'outside\n', 'utf8');
        await symlink(outside, join(root, 'rules', 'linked'), 'junction');
        const manifest = {
          ...sampleManifest,
          policies: sampleManifest.policies.map((item) => (
            item.id === 'base'
              ? { ...item, source: { path: 'rules/linked/outside.md' } }
              : item
          )),
        };
        await write('.forge/repository-policy.json', JSON.stringify(manifest));
        const bundle = await resolvePolicyBundle(options);
        expect(bundle.deliveryComplete).toBe(false);
        expect(codes(bundle.diagnostics)).toContain('SOURCE_OUTSIDE_ROOT');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('enforces per-source and total-source byte limits without partial success', async () => {
    await withPolicyFixture(async ({ options, write }) => {
      await write('rules/base.md', '0123456789');
      const single = await resolvePolicyBundle({
        ...options,
        limits: { sourceBytes: 5 },
      });
      expect(single.deliveryComplete).toBe(false);
      expect(single.bundleDigest).toBeNull();
      expect(codes(single.diagnostics)).toContain('INPUT_LIMIT');

      const total = await resolvePolicyBundle({
        ...options,
        limits: { totalSourceBytes: 5 },
      });
      expect(total.deliveryComplete).toBe(false);
      expect(total.documents).toEqual([]);
      expect(codes(total.diagnostics)).toContain('INPUT_LIMIT');
    });
  });
  it('detects content replacement during one source read using an internal test seam', async () => {
    await withPolicyFixture(async ({ root, write }) => {
      const result = await readPolicySource(
        root,
        { path: 'rules/base.md' },
        ['base'],
        1024,
        {
          afterFirstRead: async () => {
            await write('rules/base.md', 'changed\n');
          },
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostic.code).toBe('SOURCE_CHANGED');
    });
  });
});
