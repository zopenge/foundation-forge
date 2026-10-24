import { execFile } from 'node:child_process';
import { readFile, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { managedFixture } from './helpers/managed-fixture.js';
import { managedRuns } from './helpers/managed-runs.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const runs = managedRuns();
afterEach(async () => { await runs.close(); for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };

it.each(['closed', 'cancelled'])('the normal entry reclaims a durably %s run after its coordinator exits', { timeout: 240_000 }, async mode => {
  const f = await fixture(), slot = resolve(f.cwd, '.tmp/release-slot');
  const worker = resolve(import.meta.dirname, 'helpers/closed-managed-worker.mjs');
  await promisify(execFile)(process.execPath, [worker, f.cwd, mode], { windowsHide: true, timeout: 120_000 });
  const before = await readFile(resolve(slot, 'state.json'), 'utf8'), previous = JSON.parse(before);
  expect(previous.processes[0].status).toBe(mode === 'closed' ? 'closed' : 'stopped');
  // helper 只用空目录运行测试 argv；没有 checkout，可由真实入口现场生成。
  await rmdir(resolve(slot, 'checkout'));
  const report = await runs.run({ cwd: f.cwd, command: 'check' });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, slotId: previous.slotId, processes: { status: 'closed' } });
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
