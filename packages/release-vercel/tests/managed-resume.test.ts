import { execFile } from 'node:child_process';
import { readFile, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { managedFixture } from './helpers/managed-fixture.js';
import { managedRuns } from './helpers/managed-runs.js';
import type { ManagedSession } from '../src/node/release-context.js';
import { ReleaseError } from '../src/node/errors.js';
import { commandComponentSession, publicationComponentSession } from './helpers/component-session.js';

const component = vi.hoisted(() => ({ stopAfterCheckout: false }));
// 协调器退出与停止凭证仍由真实 worker 生成；入口归档在 checkout 边界验证，不重复完整成功安装。
// postinstall 失败/恢复仍实际执行 pnpm 和受管应用进程，不能以伪造回执代替。
vi.mock('../src/node/managed-process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-process.js')>();
  return { ...actual, createManagedSession: async (...args: Parameters<typeof actual.createManagedSession>) =>
    publicationComponentSession(await actual.createManagedSession(...args)) };
});
vi.mock('../src/node/managed-checkout.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/node/managed-checkout.js')>();
  return { ...actual, prepareCheckout: (session: ManagedSession) => actual.prepareCheckout(commandComponentSession(session)),
    prepareEnvironment: async (session: ManagedSession) => {
      if (component.stopAfterCheckout) throw new ReleaseError('COMMAND_FAILED', { reason: 'FIXTURE_CHECKOUT_BOUNDARY' });
      await actual.prepareEnvironment(session);
    } };
});

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const runs = managedRuns();
beforeEach(() => { component.stopAfterCheckout = false; });
afterEach(async () => { await runs.close(); for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };

it.each(['closed', 'cancelled'])('the normal entry reclaims a durably %s run after its coordinator exits before reaching installation', { timeout: 240_000 }, async mode => {
  component.stopAfterCheckout = true;
  const f = await fixture(), slot = resolve(f.cwd, '.tmp/release-slot');
  const worker = resolve(import.meta.dirname, 'helpers/closed-managed-worker.mjs');
  await promisify(execFile)(process.execPath, [worker, f.cwd, mode], { windowsHide: true, timeout: 120_000 });
  const before = await readFile(resolve(slot, 'state.json'), 'utf8'), previous = JSON.parse(before);
  expect(previous.processes[0].status).toBe(mode === 'closed' ? 'closed' : 'stopped');
  // helper 只用空目录运行测试 argv；没有 checkout，可由真实入口现场生成。
  await rmdir(resolve(slot, 'checkout'));
  const report = await runs.run({ cwd: f.cwd, command: 'check' });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: false, slotId: previous.slotId, stage: 'checkout',
    error: { code: 'COMMAND_FAILED', details: { reason: 'FIXTURE_CHECKOUT_BOUNDARY' } }, processes: { status: 'closed' } });
  expect(report.runId).not.toBe(previous.runId);
  const history = JSON.parse(await readFile(resolve(slot, 'history', `${previous.runId}.json`), 'utf8'));
  expect(history.snapshot.state).toBe(before); expect(history.stopped.processes[0].status).toBe(previous.processes[0].status);
  await expect(readFile(resolve(slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
});

it('retries a real failed pnpm lifecycle install in the same slot while retaining its failed receipt', { timeout: 360_000 }, async () => {
  const f = await fixture(), manifest = JSON.parse(await readFile(resolve(f.cwd, 'package.json'), 'utf8'));
  const script = 'const fs=require("node:fs");fs.mkdirSync("node_modules",{recursive:true});const p="node_modules/install-attempt";if(!fs.existsSync(p)){fs.writeFileSync(p,"failed once");process.exit(23)}';
  manifest.scripts = { postinstall: `node -e ${JSON.stringify(script)}` };
  await writeFile(resolve(f.cwd, 'package.json'), JSON.stringify(manifest)); f.commit();
  const failed = await runs.run({ cwd: f.cwd, command: 'check' });
  expect(failed, JSON.stringify(failed.error)).toMatchObject({ ok: false, stage: 'install', error: { code: 'COMMAND_FAILED' }, processes: { status: 'closed' } });
  expect(failed.steps.find(step => step.name === 'install')).toMatchObject({ ok: false });
  const resumed = await runs.run({ cwd: f.cwd, command: 'check' });
  expect(resumed, JSON.stringify(resumed.error)).toMatchObject({ ok: true, slotId: failed.slotId, executionRoot: failed.executionRoot });
  const history = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/history', `${failed.runId}.json`), 'utf8'));
  expect(JSON.parse(history.snapshot.check).report).toMatchObject({ ok: false, error: { code: 'COMMAND_FAILED' } });
  expect(await readFile(resolve(resumed.executionRoot ?? '', 'node_modules/install-attempt'), 'utf8')).toBe('failed once');
});
