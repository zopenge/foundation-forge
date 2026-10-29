import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { assertManagedPaths } from '../src/node/managed-paths.js';
import { fileIdentity } from '../src/node/managed-io.js';
import type { ManagedReceipt } from '../src/node/release-context.js';

// 存储组件直接准备独立真实目录、身份、原始锁和原子store；不声明Git来源或发布成功。
// 首次准入/来源索引/固定slot及重绑定由managed-state集成矩阵继续验证。
const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedSessionFixture(); fixtures.push(f); return f; };

it('preserves exact filesystem identifiers without JavaScript number rounding', async () => {
  const f = await fixture(), actual = await lstat(f.cwd, { bigint: true });
  expect(await fileIdentity(f.cwd)).toEqual({ dev: actual.dev.toString(), ino: actual.ino.toString() });
});
it('detects replaced locks and does not release the replacement', async () => {
  const f = await fixture(), slot = f.slot;
  await writeFile(slot.paths.lockPath, 'new owner');
  await expect(slot.lock.assertOwned()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  await expect(slot.lock.release()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  expect(await readFile(slot.paths.lockPath, 'utf8')).toBe('new owner');
});
it('keeps check and publish receipts separate and bounds UTF-8 output', async () => {
  const f = await fixture(), { slot, source } = f;
  const receipt: ManagedReceipt = { schemaVersion: 2, slotId: slot.slotId, source,
    report: { schemaVersion: 2, command: 'publish', ok: false, candidateSha: source.sha, configSha256: source.configSha256,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [{ name: 'check', ok: true, durationMs: 1, stdout: '中文'.repeat(2000) }],
      error: { code: 'CHECK_FAILED', details: { reason: 'STORAGE_COMPONENT_INPUT' } },
      effects: { developmentPush: 'pushed', releasePush: 'unknown' } } };
  await slot.store.writeReceipt('publish', receipt);
  await slot.store.writeReceipt('check', { ...receipt, report: { ...receipt.report, command: 'check' } });
  const saved = await slot.store.readReceipt('publish');
  expect(saved?.report.command).toBe('publish'); expect(saved?.report.effects.releasePush).toBe('unknown');
  const step = saved?.report.steps[0]; expect(Buffer.byteLength(step?.stdout ?? '')).toBeLessThanOrEqual(2048);
  expect(step?.stdout).not.toContain('\ufffd'); expect(step?.truncated).toBe(true);
  await expect(slot.store.writeReceipt('check', { ...receipt, report: { ...receipt.report, error: { code: 'IO_FAILED', details: { value: 'x'.repeat(1_048_576) } } } })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  await slot.lock.release();
});
it('rejects external Git metadata and incomplete JSON state', async () => {
  const f = await fixture(), slot = f.slot;
  // 目标只读取文件系统元数据；直接建立真实.git/commondir，不启动与路径判定无关的Git仓库初始化。
  await mkdir(resolve(slot.paths.checkoutRoot, '.git'), { recursive: true });
  await writeFile(resolve(slot.paths.checkoutRoot, '.git/commondir'), f.cwd);
  await expect(assertManagedPaths(slot.paths)).rejects.toMatchObject({ code: 'SLOT_PATH' });
  await unlink(resolve(slot.paths.checkoutRoot, '.git/commondir'));
  await writeFile(slot.paths.statePath, '{"schemaVersion":');
  await expect(slot.store.read()).rejects.toMatchObject({ code: 'SLOT_STATE' });
});
it('rejects a mismatched anchor and the anchor size limit', async () => {
  const f = await fixture(), { slot, source } = f;
  const anchor = { schemaVersion: 2 as const, slotId: slot.slotId, slotPath: slot.paths.slotRoot, configPath: source.configPath, sourceRoot: source.root };
  await expect(slot.store.writeAnchor({ ...anchor, slotId: 'foreign' })).rejects.toMatchObject({ code: 'SLOT_STATE' });
  await expect(slot.store.writeAnchor({ ...anchor, slotPath: 'x'.repeat(65_536) })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  await slot.lock.release();
});
