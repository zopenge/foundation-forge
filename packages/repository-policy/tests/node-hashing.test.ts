import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { preparePolicyRepository, resolvePolicyBundle } from '../src/node.js';
import { readPolicySource } from '../src/node/read-sources.js';
import { withPolicyFixture } from './support/node-fixture.js';
import { sampleRequest } from './support/sample.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Node policy hashing', () => {
  it.each(['one-shot', 'prepared'] as const)(
    'preserves the v1 digest without global WebCrypto through %s resolution',
    async (mode) => {
      await withPolicyFixture(async ({ options }) => {
        vi.stubGlobal('crypto', undefined);
        const bundle = await (async () => {
          if (mode === 'one-shot') return resolvePolicyBundle(options);
          const prepared = await preparePolicyRepository({ ...options, preload: 'policy-sources' });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) throw new Error('Policy fixture preparation failed');
          return prepared.repository.resolve(sampleRequest);
        })();

        expect(bundle.deliveryComplete).toBe(true);
        expect(bundle.bundleDigest).toBe('0a24f2fe097504505db8ba5ca769c9733a2e945e454f37cb468f12cf1abf1f83');
        expect(bundle.documents.map((document) => document.text)).toEqual(['api\n', 'base\n']);
      });
    },
  );

  it('reads and hashes source bytes without additional full-source Uint8Array copies', async () => {
    await withPolicyFixture(async ({ root }) => {
      const expectedBytes = Buffer.from('base\n');
      // 记录真实复制量，保留原实现，不替换文件读取或哈希结果。
      const copies = vi.spyOn(Uint8Array, 'from');
      const result = await readPolicySource(root, { path: 'rules/base.md' }, ['base'], 1024);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.text).toBe('base\n');
      expect(result.document.utf8Bytes).toBe(5);
      expect(result.document.sha256).toBe('f34848ca92665c342abd5816c9e3eda0e82180671195362bcd0080544a3bc2ac');
      const fullSourceCopies = copies.mock.calls.filter(([input]) => (
        input instanceof Uint8Array
        && expectedBytes.equals(input)
      ));
      expect(fullSourceCopies).toHaveLength(0);
    });
  });

  it('still detects equal-length replacement between the two real source reads', async () => {
    await withPolicyFixture(async ({ root, write }) => {
      const result = await readPolicySource(
        root,
        { path: 'rules/base.md' },
        ['base'],
        1024,
        { afterFirstRead: async () => write('rules/base.md', 'edit\n') },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostic.code).toBe('SOURCE_CHANGED');
    });
  });
});
