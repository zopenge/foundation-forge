import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runManagedRelease } from '../src/node/managed-release.js';
import { freezeManagedSource, inspectCommitTree } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { prepareCheckout, prepareEnvironment } from '../src/node/managed-checkout.js';
import { settleManagedSlot } from '../src/node/managed-recovery.js';
import { publishCandidate } from '../src/node/publication.js';
import { ReleaseError } from '../src/node/errors.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';

// 仅发布引擎和来源准备是组件输入；锁、状态、失败回执、归档与释放执行生产实现。
// 此例没有启动命令，空进程集合不是合成的OS关闭证明。
vi.mock('../src/node/source.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/source.js')>();
  return { ...actual, freezeManagedSource: vi.fn<typeof actual.freezeManagedSource>(), inspectCommitTree: vi.fn<typeof actual.inspectCommitTree>() };
});
vi.mock('../src/node/managed-paths.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-paths.js')>();
  return { ...actual, openManagedSlot: vi.fn<typeof actual.openManagedSlot>() };
});
vi.mock('../src/node/managed-checkout.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-checkout.js')>();
  return { ...actual, prepareCheckout: vi.fn<typeof actual.prepareCheckout>(), prepareEnvironment: vi.fn<typeof actual.prepareEnvironment>() };
});
vi.mock('../src/node/managed-recovery.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-recovery.js')>();
  return { ...actual, settleManagedSlot: vi.fn<typeof actual.settleManagedSlot>() };
});
vi.mock('../src/node/publication.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/publication.js')>();
  return { ...actual, publishCandidate: vi.fn<typeof actual.publishCandidate>() };
});

const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => { vi.resetAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
it('keeps an engine push failure unknown in the real coordinator receipt and archive before releasing its lock', async () => {
  const fixture = await managedSessionFixture(); fixtures.push(fixture);
  vi.mocked(freezeManagedSource).mockImplementation(async (cwd, path) => {
    expect(cwd).toBe(fixture.cwd); expect(path).toBe('release.config.json'); return fixture.source;
  });
  vi.mocked(inspectCommitTree).mockResolvedValue(undefined);
  vi.mocked(openManagedSlot).mockImplementation(async source => { expect(source).toBe(fixture.source); return fixture.slot; });
  vi.mocked(settleManagedSlot).mockImplementation(async options => { expect(options.cwd).toBe(fixture.cwd); });
  vi.mocked(prepareCheckout).mockResolvedValue(undefined); vi.mocked(prepareEnvironment).mockResolvedValue(undefined);
  vi.mocked(publishCandidate).mockImplementation(async (context, command) => {
    expect(command).toBe('publish'); expect(context.sha).toBe(fixture.sha);
    await context.stage('push-main'); context.effects.developmentPush = 'pushed'; context.effects.releasePush = 'unknown';
    await context.checkpoint('releasePush'); throw new ReleaseError('GIT_FAILED', { reason: 'FIXTURE_PUBLISH_BOUNDARY' });
  });
  const report = await runManagedRelease({ cwd: fixture.cwd, command: 'publish' });
  const expected = { ok: false, error: { code: 'GIT_FAILED', details: { reason: 'FIXTURE_PUBLISH_BOUNDARY' } },
    candidateSha: fixture.sha, stage: 'push-main', effects: { developmentPush: 'pushed', releasePush: 'unknown' },
    processes: { status: 'closed', knownCount: 0 } };
  expect(report).toMatchObject(expected);
  expect(report.recovery).toMatchObject({ candidateSha: fixture.sha }); expect(report.recovery?.nextCommand).toContain('recover');
  const saved = JSON.parse(await readFile(resolve(fixture.slot.paths.slotRoot, 'latest-publish.json'), 'utf8'));
  expect(saved.report).toMatchObject(expected);
  const archive = JSON.parse(await readFile(resolve(fixture.slot.paths.slotRoot, 'history', `${fixture.slot.runId}.json`), 'utf8'));
  expect(JSON.parse(archive.snapshot.publish).report).toEqual(saved.report);
  expect(JSON.parse(archive.snapshot.state)).toMatchObject({ status: 'closed', pendingPush: 'releasePush', processes: [], effects: expected.effects });
  await expect(readFile(fixture.slot.paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const call of [freezeManagedSource, inspectCommitTree, openManagedSlot, settleManagedSlot, prepareCheckout, prepareEnvironment, publishCandidate]) expect(call).toHaveBeenCalledOnce();
});
