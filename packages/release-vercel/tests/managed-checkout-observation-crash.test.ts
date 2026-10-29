import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { hasVerifiedManagedClosure } from '../src/node/managed-closure.js';
import { inspectManagedRecovery } from '../src/node/managed-recovery.js';
import { restoreManagedTerminal } from '../src/node/managed-terminal.js';
import type { ManagedPaths, ManagedState } from '../src/node/release-context.js';
import { managedFixture } from './helpers/managed-fixture.js';
import { managedRuns } from './helpers/managed-runs.js';

const fixtures: { fixture: Awaited<ReturnType<typeof managedFixture>>; stopped: boolean }[] = [], runs = managedRuns();
afterEach(async () => {
  await runs.close();
  // 若worker未提交真实子scope关闭证据，留给确认整个Job为空后的父侧收尾。
  for (const entry of fixtures.splice(0)) if (entry.stopped) await entry.fixture.dispose();
});

it.each(['after-query', 'proof-before', 'proof-after', 'state-before', 'state-after'] as const)(
  'preserves recovery facts across a real checkout batch coordinator exit at %s', async boundary => {
    const fixture = await managedFixture(), entry = { fixture, stopped: false }; fixtures.push(entry);
    await expect(promisify(execFile)(process.execPath,
      [resolve(import.meta.dirname, 'helpers/checkout-observation-crash-worker.mjs'), fixture.cwd, boundary],
      { windowsHide: true, timeout: 120_000 })).rejects.toMatchObject({ code: 71 });
    const checkpoint = JSON.parse(await readFile(resolve(fixture.root, 'observation-crash.json'), 'utf8')) as {
      paths: ManagedPaths; state: ManagedState; batch: ManagedState['processes'][number] };
    const scopes = checkpoint.batch.observations ?? [];
    expect(scopes).toHaveLength(boundary === 'after-query' ? 1 : 5);
    expect(scopes.every(hasVerifiedManagedClosure)).toBe(true); entry.stopped = true;
    const { paths } = checkpoint;
    const original = await readFile(paths.statePath, 'utf8'), lock = await readFile(paths.lockPath);
    const disk = JSON.parse(original) as ManagedState;
    const proven = ['proof-after', 'state-before', 'state-after'].includes(boundary);
    const restored = await restoreManagedTerminal(paths, disk);
    const observation = await inspectManagedRecovery(restored.state, paths);
    expect(observation).toMatchObject({ owner: 'inactive', processes: proven ? 'closed' : 'unknown', knownCount: proven ? 5 : 0 });
    expect(await readFile(paths.statePath, 'utf8')).toBe(original);
    if (!proven) {
      expect(disk.processes.at(-1)).toMatchObject({ kind: 'checkout-observation', status: 'intent', observationComplete: false, observations: [] });
      await expect(readFile(resolve(paths.slotRoot, 'terminal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      const terminal = JSON.parse(await readFile(resolve(paths.slotRoot, 'terminal.json'), 'utf8'));
      expect(terminal.command.observations).toHaveLength(5);
      expect(restored.state.processes.at(-1)).toMatchObject({ kind: 'checkout-observation', status: 'closed', observationComplete: true, terminalSha256: terminal.proofSha256 });
    }
    const report = await runs.run({ cwd: fixture.cwd, command: 'recover' });
    if (proven) {
      expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, processes: { status: 'closed', knownCount: 5 } });
      const history = JSON.parse(await readFile(resolve(paths.slotRoot, 'history', `${disk.runId}.json`), 'utf8'));
      expect(history.snapshot.state).toBe(original);
      expect(history.stopped.processes).toHaveLength(1);
      expect(history.stopped.processes[0].observations).toHaveLength(5);
      await expect(readFile(paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(resolve(paths.slotRoot, '.state.json.next'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(report, JSON.stringify(report.error)).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN' }, processes: { status: 'unknown' } });
      expect(await readFile(paths.lockPath)).toEqual(lock);
    }
    expect(await readFile(paths.statePath, 'utf8')).toBe(original);
    await expect(readFile(resolve(paths.slotRoot, 'latest-check.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.ref('dev')).toBe(fixture.initial); expect(fixture.ref('main')).toBe(fixture.initial);
  });
