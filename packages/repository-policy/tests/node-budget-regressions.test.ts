import type { PathLike } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { PolicyDiagnostic } from '../src/contracts.js';
import {
  checkPolicyRepository,
  preparePolicyRepository,
  resolvePolicyBundle,
  type NodePolicyOptions,
} from '../src/node.js';
import { withPolicyFixture } from './support/node-fixture.js';

const growthHook: {
  afterStat: ((path: PathLike) => Promise<void>) | undefined;
  beforeRead: ((path: string) => Promise<void>) | undefined;
} = vi.hoisted(() => ({ afterStat: undefined, beforeRead: undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      const metadata = await original.stat(...args);
      await growthHook.afterStat?.(args[0]);
      return metadata;
    },
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      if (typeof args[0] === 'string') await growthHook.beforeRead?.(args[0]);
      return original.readFile(...args);
    },
  };
});

const withGrowingSources = async (
  action: (options: NodePolicyOptions) => Promise<void>,
): Promise<void> => {
  await withPolicyFixture(async ({ root, options, write }) => {
    const sourcePaths = new Set([
      join(root, 'rules', 'api.md'),
      join(root, 'rules', 'base.md'),
    ]);
    await write('rules/api.md', '1234');
    await write('rules/base.md', '1234');
    const inspected = new Set<string>();
    let changed = false;
    growthHook.afterStat = async (path) => {
      if (changed || typeof path !== 'string' || !sourcePaths.has(path)) return;
      inspected.add(path);
      if (inspected.size !== sourcePaths.size) return;
      changed = true;
      // 两份真实 stat 已取得；正文在首次读取前增长，总量从 8 变成 16 字节。
      await Promise.all([
        write('rules/api.md', '12345678'),
        write('rules/base.md', '12345678'),
      ]);
    };

    try {
      await action({
        ...options,
        limits: { sourceBytes: 16, totalSourceBytes: 8 },
      });
    } finally {
      growthHook.afterStat = undefined;
    }
  });
};

const expectSourceBudgetRejection = (
  diagnostics: readonly PolicyDiagnostic[],
): void => {
  expect(diagnostics.some((item) => (
    item.code === 'SOURCE_CHANGED' || item.code === 'INPUT_LIMIT'
  ))).toBe(true);
};

describe('source growth after total-budget inspection', () => {
  it('rejects a check whose sources grow beyond the inspected total', async () => {
    await withGrowingSources(async (options) => {
      const report = await checkPolicyRepository(options);
      expect(report.state).toBe('failed');
      expectSourceBudgetRejection(report.diagnostics);
    });
  });

  it.each(['fresh', 'prepared'] as const)(
    'rejects %s resolution whose sources grow beyond the inspected total',
    async (mode) => {
      await withGrowingSources(async (options) => {
        const prepared = mode === 'prepared'
          ? await preparePolicyRepository(options)
          : undefined;
        if (prepared !== undefined && !prepared.ok) {
          throw new Error('fixture preparation failed');
        }
        const bundle = prepared?.ok
          ? await prepared.repository.resolve(options.request)
          : await resolvePolicyBundle(options);
        expect(bundle.deliveryComplete).toBe(false);
        expect(bundle.bundleDigest).toBeNull();
        expectSourceBudgetRejection(bundle.diagnostics);
      });
    },
  );

  it('rejects preloading whose sources grow beyond the inspected total', async () => {
    await withGrowingSources(async (options) => {
      const prepared = await preparePolicyRepository({
        ...options,
        preload: 'policy-sources',
      });
      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expectSourceBudgetRejection(prepared.diagnostics);
    });
  });

  it('enforces the delivered total when a concurrent resolution fills the cache', async () => {
    await withPolicyFixture(async ({ root, options, write }) => {
      await write('rules/api.md', '1234');
      await write('rules/base.md', '1234');
      const prepared = await preparePolicyRepository({
        ...options,
        limits: { sourceBytes: 16, totalSourceBytes: 8 },
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      let signalReadStarted: (() => void) | undefined;
      let releaseRead: (() => void) | undefined;
      const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve; });
      const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
      const apiPath = join(root, 'rules', 'api.md');
      let gated = false;
      growthHook.beforeRead = async (path) => {
        if (path !== apiPath || gated) return;
        gated = true;
        signalReadStarted?.();
        await readReleased;
      };

      // 第一次解析已按 4 + 4 字节预检，暂停在 api 正文首次读取之前。
      const pending = prepared.repository.resolve(options.request);
      const settled = Promise.allSettled([pending]);
      try {
        await Promise.race([
          readStarted,
          settled.then(() => { throw new Error('resolution ended before reaching the read gate'); }),
        ]);
        await write('rules/base.md', '12345678');
        const baseOnly = await prepared.repository.resolve({
          ...options.request,
          facts: [{
            id: 'api-impact',
            state: 'false',
            basis: 'verified',
            contextId: options.request.contextId,
            evidenceIds: ['base-only'],
          }],
          evidence: [{
            id: 'base-only',
            contextId: options.request.contextId,
            sourceId: 'budget-fixture',
            digest: 'no-api-impact',
          }],
        });
        expect(baseOnly.deliveryComplete).toBe(true);
        expect(baseOnly.documents.map((item) => [item.source.path, item.utf8Bytes])).toEqual([
          ['rules/base.md', 8],
        ]);

        releaseRead?.();
        const bundle = await pending;
        expect(bundle.deliveryComplete).toBe(false);
        expect(bundle.bundleDigest).toBeNull();
        expect(bundle.diagnostics).toContainEqual(expect.objectContaining({
          code: 'INPUT_LIMIT',
          fieldPath: 'limits.totalSourceBytes',
        }));
      } finally {
        growthHook.beforeRead = undefined;
        releaseRead?.();
        await settled;
      }
    });
  });
});
