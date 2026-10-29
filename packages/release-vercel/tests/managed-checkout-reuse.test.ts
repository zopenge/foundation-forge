import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseError } from '../src/node/errors.js';
import type { ManagedSession } from '../src/node/release-context.js';
import { prepareEnvironment } from '../src/node/managed-checkout.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import { managedRuns } from './helpers/managed-runs.js';
import { commandComponentSession } from './helpers/component-session.js';

// 只验证 checkout/入口复用。安装前以明确错误停止，不把组件测试当成完整 check 成功。
// Git 和 slot 文件/锁仍真实；受管进程授权/持久化由 managed-process、terminal 及完整端到端保留验证。
vi.mock('../src/node/managed-checkout.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-checkout.js')>();
  return { ...actual, prepareCheckout: async (session: ManagedSession) => {
    await actual.prepareCheckout(commandComponentSession(session));
  }, prepareEnvironment: vi.fn(async () => { throw new ReleaseError('COMMAND_FAILED', { reason: 'FIXTURE_CHECKOUT_BOUNDARY' }); }) };
});

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const runs = managedRuns();
afterEach(async () => { await runs.close(); vi.clearAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };
async function checkout(f: Awaited<ReturnType<typeof fixture>>) {
  const report = await runs.run({ cwd: f.cwd, command: 'check' });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: false, stage: 'checkout',
    error: { code: 'COMMAND_FAILED', details: { reason: 'FIXTURE_CHECKOUT_BOUNDARY' } },
    processes: { status: 'closed' }, effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } });
  expect(report.executionRoot).toBeDefined();
  await expect(readFile(resolve(f.cwd, '.tmp/release-slot/run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  return { report, root: report.executionRoot ?? '' };
}

it('reuses the normal entry slot at the same SHA and fast-forwards checkout without replacing cache or lockfile', async () => {
  const f = await fixture(), first = await checkout(f);
  const dependency = resolve(first.root, 'node_modules/fixture-preserved'); await mkdir(resolve(first.root, 'node_modules'), { recursive: true });
  await writeFile(dependency, 'keep'); const lock = await readFile(resolve(first.root, 'pnpm-lock.yaml'));
  const second = await checkout(f);
  expect(second.report).toMatchObject({ slotId: first.report.slotId, executionRoot: first.root, candidateSha: f.sha });
  expect(git(second.root, 'rev-parse', 'HEAD')).toBe(f.sha);
  await writeFile(resolve(f.cwd, 'source.txt'), 'next'); const sha = f.commit(), third = await checkout(f);
  expect(third.report).toMatchObject({ slotId: first.report.slotId, executionRoot: first.root, candidateSha: sha });
  expect(git(third.root, 'rev-parse', 'HEAD')).toBe(sha);
  expect(await readFile(dependency, 'utf8')).toBe('keep'); expect(await readFile(resolve(third.root, 'pnpm-lock.yaml'))).toEqual(lock);
  expect(prepareEnvironment).toHaveBeenCalledTimes(3);
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
});

it('keeps dirty checkout bytes and rejects before reaching the installation boundary', async () => {
  const f = await fixture(), first = await checkout(f), path = resolve(first.root, 'source.txt');
  await writeFile(path, 'user modification');
  const report = await runs.run({ cwd: f.cwd, command: 'check' });
  expect(report).toMatchObject({ ok: false, error: { code: 'GIT_DIRTY' } });
  expect(await readFile(path, 'utf8')).toBe('user modification');
  expect(prepareEnvironment).toHaveBeenCalledTimes(1);
});
