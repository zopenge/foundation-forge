import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';

// 仅组件边界：所有文件写入、命令和监督器均不可透传；外层正式context监督本worker。
const phase = process.argv[2], controller = new globalThis.AbortController();
const reason = new Error('late cancellation'), primary = phase.endsWith('-falsy') ? 0 : new Error('merge failed'), cleanup = new Error('audit failed');
const root = process.env.FORGE_CHECK_JOB_TEMP;
if (!root) throw new Error('owned test root required');
const module = (name, namedExports) => mock.module(new URL(`../../${name}`, import.meta.url).href, { namedExports });
await module('check-fingerprint.mjs', { collectWorkspaceFingerprint: async () => ({ files: {}, environmentDigest: 'fixture' }), collectDistDigests: async () => ({}) });
await module('workspace-packages.mjs', { discoverWorkspacePackageModel: async () => ({ packages: [] }) });
const context = { root, budget: { limit: 1 }, run: async () => { throw primary; },
  finalize: async () => { if (phase.startsWith('own-')) throw cleanup; controller.abort(reason); } };
await module('test-run-context.mjs', { createTestRunContext: async () => context });
await mock.module('node:child_process', { namedExports: { spawnSync: () => ({ status: 0, stdout: 'a'.repeat(40) }) } });
const deniedFs = Object.fromEntries(Object.entries(fs).filter(([key]) => key !== 'default').map(([key, value]) =>
  [key, typeof value === 'function' ? () => { throw new Error(`unexpected fs operation: ${key}`); } : value]));
const fakeFs = { ...deniedFs,
  lstat: async path => {
    assert.ok(String(path).replaceAll('\\', '/').endsWith('/.tmp/ci-shards/part-1'));
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  },
  readFile: async path => {
    if (String(path).replaceAll('\\', '/').endsWith('/node_modules/vitest/package.json')) return '{"version":"4.1.9"}';
    if (resolve(path) === resolve(root, 'summary.json')) {
      if (phase === 'before-write') controller.abort(reason);
      return '{}';
    }
    assert.equal(resolve(path), resolve(root, 'blob.json')); return Buffer.from('fixture blob');
  },
  mkdir: async path => { assert.equal(resolve(path), resolve(root, 'blobs')); },
};
await mock.module('node:fs/promises', { namedExports: fakeFs, defaultExport: fakeFs });

if (phase.startsWith('own-')) {
  const { mergeWorkspaceCoverage, runWorkspaceCoverageBatch } = await import('../../run-workspace-coverage-batch.mjs');
  const operation = phase.startsWith('own-batch') ? runWorkspaceCoverageBatch({ shard: '1/2' }) : mergeWorkspaceCoverage({ blobsDirectory: root });
  await assert.rejects(operation, error =>
    error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(cleanup) && error.cause === primary);
} else {
  await module('check-full.mjs', { runFullCheck: async options => { await options.coverage({ context, packages: [] }); } });
  await module('run-workspace-coverage-batch.mjs', {
    runWorkspaceCoverageBatch: async () => ({ blobPath: `${root}/blob.json`, result: { testResults: [], numPassedTests: 0, numPendingTests: 0 } }),
    mergeWorkspaceCoverage: async () => {},
  });
  let persisted = 0;
  await module('ci-coverage-shards.mjs', { parseCoverageShard: () => ({ index: 1, count: 2 }),
    persistCoverageShard: async () => { persisted++; await Promise.resolve(); controller.abort(reason); },
    readCoverageShardArtifacts: async () => ({ expected: {}, blobs: [] }),
  });
  const { runCiCheck } = await import('../../check-ci.mjs');
  await assert.rejects(runCiCheck(['shard', 'before-write'].includes(phase) ? ['--shard', '1/2'] : ['--merge', root], controller.signal), error => error === reason);
  if (phase === 'before-write') assert.equal(persisted, 0);
}
