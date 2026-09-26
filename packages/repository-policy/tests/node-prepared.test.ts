import { describe, expect, it } from 'vitest';

import {
  preparePolicyRepository,
  resolvePolicyBundle,
} from '../src/node.js';
import {
  sampleManifest,
  sampleRequest,
} from './support/sample.js';
import { withPolicyFixture } from './support/node-fixture.js';

describe('prepared policy repository', () => {
  it.each(['before-ready', 'after-ready'])(
    'keeps the declared root fixed when options change %s',
    async (timing) => {
      await withPolicyFixture(async ({ options }) => {
        await withPolicyFixture(async (other) => {
          await other.write('rules/base.md', 'other repository\n');
          const mutableOptions = {
            root: options.root,
            manifestPath: options.manifestPath,
          };
          const preparation = preparePolicyRepository(mutableOptions);
          if (timing === 'before-ready') {
            mutableOptions.root = other.root;
            mutableOptions.manifestPath = 'other.json';
          }
          const prepared = await preparation;
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) return;
          if (timing === 'after-ready') {
            mutableOptions.root = other.root;
            mutableOptions.manifestPath = 'other.json';
          }

          const bundle = await prepared.repository.resolve(sampleRequest);
          expect(prepared.repository.root).toBe(options.root);
          expect(prepared.repository.manifestPath).toBe(options.manifestPath);
          expect(bundle.deliveryComplete).toBe(true);
          expect(bundle.documents.find(
            (item) => item.source.path === 'rules/base.md',
          )?.text).toBe('base\n');
        });
      });
    },
  );

  it('does not expose cached source identities through returned documents', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository(options);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const first = await prepared.repository.resolve(sampleRequest);
      const firstSource = first.documents.find(
        (item) => item.source.path === 'rules/base.md',
      )?.source;
      expect(firstSource).toBeDefined();
      Object.assign(firstSource ?? {}, { path: 'rules/altered.md' });

      const second = await prepared.repository.resolve(sampleRequest);
      expect(second.documents.map((item) => item.source.path)).toEqual([
        'rules/api.md',
        'rules/base.md',
      ]);
      expect(second.bundleDigest).toBe(first.bundleDigest);
    });
  });

  it('reuses a validated manifest and safely cached rule documents', async () => {
    await withPolicyFixture(async ({
      options,
      write,
    }) => {
      const prepared = await preparePolicyRepository(
        options,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const first = await prepared.repository.resolve(
        sampleRequest,
      );
      const firstBase = first.documents.find(
        (item) => item.source.path === 'rules/base.md',
      );
      expect(firstBase?.text).toBe('base\n');

      await write('rules/base.md', 'base changed\n');
      const second = await prepared.repository.resolve(
        sampleRequest,
      );
      const secondBase = second.documents.find(
        (item) => item.source.path === 'rules/base.md',
      );
      expect(secondBase?.text).toBe('base\n');
      expect(secondBase?.sha256).toBe(
        firstBase?.sha256,
      );
      const fresh = await resolvePolicyBundle(options);
      expect(
        fresh.documents.find(
          (item) => item.source.path === 'rules/base.md',
        )?.text,
      ).toBe('base changed\n');
    });
  });

  it('keeps manifest identity fixed inside one prepared snapshot', async () => {
    await withPolicyFixture(async ({
      options,
      write,
    }) => {
      const prepared = await preparePolicyRepository(
        options,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      await write(
        '.forge/repository-policy.json',
        JSON.stringify({
          ...sampleManifest,
          policies: [sampleManifest.policies[0]],
        }),
      );

      const fromPrepared = await prepared.repository.resolve(
        sampleRequest,
      );
      expect(
        fromPrepared.resolution.candidateIds,
      ).toEqual(['api']);

      const fresh = await resolvePolicyBundle(options);
      expect(fresh.resolution.candidateIds).toEqual([]);
    });
  });
  it('still enforces per-request byte limits', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository({
        root: options.root,
        manifestPath: options.manifestPath,
        limits: {
          requestBytes: 8,
        },
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const result = await prepared.repository.resolve(
        sampleRequest,
      );
      expect(result.deliveryComplete).toBe(false);
      expect(
        result.diagnostics.map((item) => item.code),
      ).toContain('INPUT_LIMIT');
    });
  });

  it('can preload and freeze policy sources before the first resolve', async () => {
    await withPolicyFixture(async ({
      options,
      write,
    }) => {
      const prepared = await preparePolicyRepository({
        root: options.root,
        manifestPath: options.manifestPath,
        preload: 'policy-sources',
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      await write('rules/base.md', 'changed after preload\n');
      const bundle = await prepared.repository.resolve(
        sampleRequest,
      );
      expect(
        bundle.documents.find(
          (item) => item.source.path === 'rules/base.md',
        )?.text,
      ).toBe('base\n');
    });
  });

  it('applies the total source budget to explicit preloading', async () => {
    await withPolicyFixture(async ({ options }) => {
      const prepared = await preparePolicyRepository({
        root: options.root,
        manifestPath: options.manifestPath,
        preload: 'policy-sources',
        limits: {
          totalSourceBytes: 4,
        },
      });
      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expect(
        prepared.diagnostics.map((item) => item.code),
      ).toContain('INPUT_LIMIT');
    });
  });

  it('rejects an invalid manifest during preparation', async () => {
    await withPolicyFixture(async ({
      options,
      write,
    }) => {
      await write(
        '.forge/repository-policy.json',
        '{"schemaVersion":1,"factIds":[],"policies":[],"checks":[]}',
      );
      const prepared = await preparePolicyRepository(
        options,
      );
      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expect(
        prepared.diagnostics.map((item) => item.code),
      ).toContain('INVALID_SCHEMA');
    });
  });
});
