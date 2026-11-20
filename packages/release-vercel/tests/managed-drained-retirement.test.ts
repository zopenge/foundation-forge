import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ReleaseConfig } from '../src/contracts.js';
import { runRelease } from '../src/node.js';
import { Execution } from '../src/node/execution.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { retirementCessation } from '../src/node/retirement-record.js';
import type { ManagedCommand, ManagedState } from '../src/node/managed-state-contracts.js';
import type { RetirementRecord } from '../src/node/retirement-contracts.js';
import { installReadQueryComponentExecution } from './helpers/component-command-runtime.mjs';

let restoreExecution: (() => void) | undefined;
beforeEach(() => { restoreExecution = installReadQueryComponentExecution(Execution); });
afterEach(() => { restoreExecution?.(); });

it.runIf(process.platform === 'win32' && process.arch === 'x64')('retires a failed real Windows check after native cleanup proved the Job empty', async () => {
  const value = await fixture();
  const configPath = resolve(value.cwd, 'release.config.json'), marker = resolve(value.root, 'descendant-writes.txt');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ReleaseConfig;
  const writer = 'setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),100)';
  const parent = `const fs=require('node:fs');const path=process.argv[1];const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},path],{stdio:'ignore',detached:true,windowsHide:true});child.unref();setInterval(()=>{if(fs.existsSync(path))process.exit(1)},100)`;
  await writeFile(configPath, JSON.stringify({ ...config, checks: [...config.checks, { command: 'node', args: ['-e', parent, marker] }] }));
  const sha = value.commit();
  const failed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(failed, JSON.stringify(failed.error)).toMatchObject({ ok: false, candidateSha: sha, stage: 'checks', processes: { status: 'unknown' },
    error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'CLOSURE_UNPROVEN', step: 'check:1', exitCode: 1,
      termination: 'termination-failure', scopeReason: 'descendants-remained', empty: true, identified: true } } });
  expect(failed.runId).toBeDefined();
  if (!failed.runId) throw new Error('failed run receipt required');
  const slot = resolve(value.cwd, 'state/release-slot');
  const statePath = resolve(slot, 'state.json'), receiptPath = resolve(slot, 'latest-publish.json'), lockPath = resolve(slot, 'run.lock');
  const state = await readFile(statePath, 'utf8'), receipt = await readFile(receiptPath, 'utf8'), lock = await readFile(lockPath, 'utf8');
  expect((await readFile(marker)).length).toBeGreaterThan(0);
  await expect(value.creates()).rejects.toMatchObject({ code: 'ENOENT' });
  const recovery = await runRelease({ command: 'recover', cwd: value.cwd });
  expect(recovery).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'CLOSURE_UNPROVEN' } } });
  const retired = await runRelease({ command: 'retire', cwd: value.cwd, runId: failed.runId });
  expect(retired, JSON.stringify(retired.error)).toMatchObject({ ok: true, runId: failed.runId, processes: { status: 'closed' },
    retirement: { status: 'retired', historicalVerification: 'unknown', cessation: 'recorded-empty-drained-scope' } });
  expect(await readFile(statePath, 'utf8')).toBe(state);
  expect(await readFile(receiptPath, 'utf8')).toBe(receipt);
  const archive = JSON.parse(await readFile(resolve(slot, 'retired', `${failed.runId}.json`), 'utf8')) as RetirementRecord;
  expect(archive).toMatchObject({ snapshot: { state, publish: receipt, lock }, final: { observation: { owner: 'inactive', processes: 'closed' } } });
  const original = JSON.parse(state) as ManagedState;
  expect(retirementCessation(original, { ...archive.snapshot, publish: null })).toBeUndefined();
  const first = original.processes[0], last = original.processes.at(-1), closure = last?.closure, scope = closure?.ownedScope;
  if (!first || !last?.identity || !closure || scope?.status !== 'unknown') throw new Error('original native closure required');
  const replaceLast = (command: ManagedCommand): ManagedState => ({ ...original, processes: [...original.processes.slice(0, -1), command] });
  const tamperedStates: ManagedState[] = [
    { ...original, effects: { ...original.effects, releasePush: 'pushed' } },
    { ...original, processes: [{ ...first, status: 'unknown' }, ...original.processes.slice(1)] },
    replaceLast({ ...last, closure: { ...closure, exitCode: 0 } }),
    replaceLast({ ...last, closure: { ...closure, ownedScope: { ...scope, reason: 'provider-failed' } } }),
    replaceLast({ ...last, closure: { ...closure, ownedScope: { ...scope, empty: false } } }),
    replaceLast({ ...last, closure: { ...closure, ownedScope: { ...scope, binding: `${scope.binding}-other` } } }),
    replaceLast({ ...last, identity: { ...last.identity, startToken: 'different-instance' } }),
  ];
  for (const tampered of tamperedStates) {
    expect(retirementCessation(tampered, { ...archive.snapshot, state: JSON.stringify(tampered) })).toBeUndefined();
  }
  await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const recovered = await runRelease({ command: 'recover', cwd: value.cwd });
  expect(recovered, JSON.stringify(recovered.error)).toMatchObject({ command: 'recover', ok: true, runId: failed.runId,
    sourceRoot: failed.sourceRoot, candidateSha: sha, configSha256: failed.configSha256, effects: failed.effects,
    processes: { status: 'closed' }, recovery: { reportExists: true, observation: { owner: 'inactive', processes: 'closed' } } });
  expect(await readFile(statePath, 'utf8')).toBe(state);
  expect(await readFile(receiptPath, 'utf8')).toBe(receipt);
  const next = await openManagedSlot(original.source, new Execution(value.cwd, original.source.config, undefined, []));
  try { expect(next.slotId).toBe(failed.slotId); expect(next.runId).not.toBe(failed.runId); }
  finally { await next.lock.release(); }
}, 120_000);
