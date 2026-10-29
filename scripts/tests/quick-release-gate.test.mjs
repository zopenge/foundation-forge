import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFullReceipt } from '../check-release-gate.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publishIfNeeded } from '../publish-if-needed.mjs';
import { writeFullState, writeState } from '../check-runner.mjs';
const current = { schemaVersion: 1, environmentDigest: 'env', files: { source: 'sha' } };
const distDigests = { package: 'dist' }, tarballDigests = { package: { filename: 'p.tgz', sha256: 'tgz' } };
const state = { ...current, validation: { schemaVersion: 1, kind: 'full' }, distDigests, tarballDigests };
const verify = receipt => assertFullReceipt({ state: receipt, current, distDigests, tarballDigests });
test('发布门禁只接受当前完整指纹、dist和真实 tarball摘要匹配的 full 收据', () => {
  assert.doesNotThrow(() => verify(state));
  for (const receipt of [null, { ...state, validation: undefined }, { ...state, validation: { schemaVersion: 1, kind: 'quick' } },
    { ...state, files: { source: 'old' } }, { ...state, environmentDigest: 'old' },
    { ...state, distDigests: { package: 'old' } }, { ...state, tarballDigests: {} }])
    assert.throws(() => verify(receipt), error => error.code === 'FULL_CHECK_REQUIRED');
});
test('直接 JS 发布调用在 quick 收据下拒绝，不访问 registry、不打包', async t => {
  const base = resolve(import.meta.dirname, '../../.tmp/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'quick-gate-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, '.tmp/check-cache'), { recursive: true });
  const path = resolve(root, '.tmp/check-cache/state.json'), bytes = JSON.stringify({ ...state, validation: { schemaVersion: 1, kind: 'quick' } });
  await writeFile(path, bytes);
  t.mock.method(globalThis, 'fetch', () => assert.fail('发布门禁前不得查询 registry'));
  for (const bootstrap of [false, true]) await assert.rejects(publishIfNeeded({ model: { repositoryRoot: root }, bootstrap }), error => error.code === 'FULL_CHECK_REQUIRED');
  assert.equal(await readFile(path, 'utf8'), bytes);
});
test('只有完整入口的写入携带 full 标记，旧增量写入不提升为 full', async () => {
  let text;
  const io = { mkdir: async () => {}, open: async () => ({ writeFile: async value => { text = value; }, close: async () => {} }),
    renameSync: () => {}, rm: async () => {} };
  await writeState(current, distDigests, tarballDigests, undefined, io);
  assert.equal(JSON.parse(text).validation, undefined);
  await writeFullState(current, distDigests, tarballDigests, undefined, io);
  assert.deepEqual(JSON.parse(text).validation, { schemaVersion: 1, kind: 'full' });
});
