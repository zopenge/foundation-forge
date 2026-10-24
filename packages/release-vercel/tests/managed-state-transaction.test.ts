import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { managedFixture } from './helpers/managed-fixture.js';
import { managedRuns } from './helpers/managed-runs.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [], runs = managedRuns();
afterEach(async () => { await runs.close(); for (const f of fixtures.splice(0)) await f.dispose(); });
async function interrupted(phase: 'before' | 'after', stage: 'closure' | 'later') {
  const f = await managedFixture(); fixtures.push(f);
  const worker = resolve(import.meta.dirname, 'helpers/state-transaction-worker.mjs');
  await expect(promisify(execFile)(process.execPath, [worker, f.cwd, phase, stage], { windowsHide: true, timeout: 120_000 }))
    .rejects.toMatchObject({ code: 71 });
  const slot = resolve(f.cwd, '.tmp/release-slot'), statePath = resolve(slot, 'state.json');
  expect(await readFile(resolve(slot, 'checkout/crash-boundary'), 'utf8')).toBe(`${phase}:${stage}`);
  const original = await readFile(statePath, 'utf8');
  return { ...f, slot, statePath, original, state: JSON.parse(original) };
}

// 没有写前身份事务时，真实 state rename 后协调者退出会让这两项恢复断言失败。
it.each(['closure', 'later'] as const)('recovers after state rename before terminal rebinding at %s', async stage => {
  const f = await interrupted('after', stage);
  const report = await runs.run({ cwd: f.cwd, command: 'recover' });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, runId: f.state.runId, processes: { status: 'closed' } });
  expect(await readFile(f.statePath, 'utf8')).toBe(f.original);
  const history = JSON.parse(await readFile(resolve(f.slot, 'history', `${f.state.runId}.json`), 'utf8'));
  expect(history.snapshot.state).toBe(f.original);
  expect(history.stopped.processes).toHaveLength(1);
  expect(history.stopped.processes[0]).toMatchObject({ name: 'once-only', status: 'closed', closure: { ownedScope: { empty: true } } });
  expect(await readFile(resolve(f.slot, 'checkout/executions'), 'utf8')).toBe('x');
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  await expect(readFile(resolve(f.slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('still rejects a same-byte state replacement after the real interrupted rename', async () => {
  const f = await interrupted('after', 'closure');
  await rename(f.statePath, resolve(f.slot, 'checkout/original-state'));
  await writeFile(f.statePath, f.original);
  const report = await runs.run({ cwd: f.cwd, command: 'recover' });
  expect(report).toMatchObject({ ok: false, error: { code: 'SLOT_STATE', details: { reason: 'METADATA_REPLACED' } } });
  expect(await readFile(resolve(f.slot, 'checkout/executions'), 'utf8')).toBe('x');
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toContain(f.state.runId);
});

it.each(['closure', 'later'] as const)('recovers before state rename and reclaims the sealed temporary file at %s', async stage => {
  const f = await interrupted('before', stage), temporary = resolve(f.slot, '.state.json.next');
  expect(await readFile(temporary, 'utf8')).not.toBe(f.original);
  const report = await runs.run({ cwd: f.cwd, command: 'recover' });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, runId: f.state.runId, processes: { status: 'closed' } });
  expect(await readFile(f.statePath, 'utf8')).toBe(f.original);
  await expect(readFile(temporary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const history = JSON.parse(await readFile(resolve(f.slot, 'history', `${f.state.runId}.json`), 'utf8'));
  expect(history.snapshot.state).toBe(f.original);
  expect(JSON.parse(history.snapshot.terminal)).toMatchObject({ stateTransition: { to: { sha256: expect.any(String) } } });
  expect(history.stopped.processes[0]).toMatchObject({ status: 'closed', closure: { ownedScope: { empty: true } } });
  expect(await readFile(resolve(f.slot, 'checkout/executions'), 'utf8')).toBe('x');
  await expect(readFile(resolve(f.slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not reclaim a copied pending state or unlock its interrupted run', async () => {
  const f = await interrupted('before', 'closure'), temporary = resolve(f.slot, '.state.json.next');
  const contents = await readFile(temporary);
  await rename(temporary, resolve(f.slot, 'checkout/original-prepared-state')); await writeFile(temporary, contents);
  const report = await runs.run({ cwd: f.cwd, command: 'recover' });
  expect(report).toMatchObject({ ok: false, error: { code: 'SLOT_STATE' } });
  expect(await readFile(temporary)).toEqual(contents);
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toContain(f.state.runId);
});
