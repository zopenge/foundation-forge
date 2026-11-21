import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProcessControlError, processControlErrorCodes, type ProcessIdentityReader } from '@openge/forge-process-control';
import type { ReleaseConfig } from '../src/contracts.js';
import { runRelease } from '../src/node.js';
import { Execution } from '../src/node/execution.js';
import { ReleaseError } from '../src/node/errors.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { retirementCessation } from '../src/node/retirement-record.js';
import { inspectManagedRecovery, readManagedLocation } from '../src/node/managed-recovery.js';
import { acquireManagedCoordinatorLease } from '../src/node/retirement-host.js';
import * as identityBoundary from '../src/node/process-identities.js';
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
  const identity = last.identity;
  const ticks = /^\/Date\((\d+)\)\/$/u.exec(identity.startToken)?.[1];
  if (!ticks) throw new Error('missing native Windows process creation time');
  const newer = { ProcessId: identity.pid, CreationDate: '/Date(' + (Number(ticks) + 1000) + ')/' };
  const nativeAccessDenied = (nativeCode: number): ProcessIdentityReader => ({
    readIdentity: async request => {
      if (request.pid !== identity.pid) return { status: 'ABSENT' };
      throw new ProcessControlError(processControlErrorCodes.commandFailed, { backend: 'windows-native', stage: 'OPEN_PROCESS', nativeCode });
    },
  });
  const query = vi.spyOn(identityBoundary, 'queryWindowsCimIdentity').mockResolvedValue([newer]);
  const location = await readManagedLocation(value.cwd, 'release.config.json');
  const nativeLease = await acquireManagedCoordinatorLease(location.paths, original.host);
  try {
    const inspect = (reader: ProcessIdentityReader, snapshot?: RetirementRecord['snapshot']) =>
      inspectManagedRecovery(original, location.paths, undefined, reader, nativeLease, snapshot);
    await expect(inspect(nativeAccessDenied(5), archive.snapshot)).resolves.toMatchObject({ owner: 'inactive', processes: 'closed' });
    expect(query).toHaveBeenCalledExactlyOnceWith(identity.pid, expect.any(AbortSignal));
    for (const evidence of [[], newer, [{ ...newer, CreationDate: identity.startToken }], [{ ...newer, ProcessId: identity.pid + 1 }],
      [{ ...newer, CreationDate: 'unavailable' }], [{ ...newer, CreationDate: '/Date(' + (Number(ticks) - 1) + ')/' }],
      [newer, newer], [newer, {}]]) {
      query.mockResolvedValueOnce(evidence);
      await expect(inspect(nativeAccessDenied(5), archive.snapshot)).resolves.toMatchObject({ processes: 'unknown' });
    }
    query.mockRejectedValueOnce(new Error('identity unavailable'));
    await expect(inspect(nativeAccessDenied(5), archive.snapshot)).resolves.toMatchObject({ processes: 'unknown' });
    query.mockClear();
    await expect(inspect(nativeAccessDenied(87), archive.snapshot)).resolves.toMatchObject({ processes: 'unknown' });
    await expect(inspect(nativeAccessDenied(5))).resolves.toMatchObject({ processes: 'unknown' });
    await expect(inspect(nativeAccessDenied(5), { ...archive.snapshot, publish: null })).resolves.toMatchObject({ processes: 'unknown' });
    await expect(inspect(nativeAccessDenied(5), { ...archive.snapshot, state: '{}' })).resolves.toMatchObject({ processes: 'unknown' });
    await expect(inspect({ readIdentity: async () => ({ status: 'FOUND', identity }) }, archive.snapshot))
      .resolves.toMatchObject({ processes: 'running' });
    expect(query).not.toHaveBeenCalled();
  } finally {
    await nativeLease.release();
    query.mockRestore();
  }
  expect(await readFile(statePath, 'utf8')).toBe(state);
  expect(await readFile(receiptPath, 'utf8')).toBe(receipt);
  const next = await openManagedSlot(original.source, new Execution(value.cwd, original.source.config, undefined, []));
  try { expect(next.slotId).toBe(failed.slotId); expect(next.runId).not.toBe(failed.runId); }
  finally { await next.lock.release(); }
}, 120_000);

it.runIf(process.platform === 'win32' && process.arch === 'x64')('releases drained acceptance locally and resumes only the original prebuilt candidate', async () => {
  const value = await fixture();
  const configPath = resolve(value.cwd, 'release.config.json'), marker = resolve(value.root, 'acceptance-started.txt');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ReleaseConfig;
  const writer = 'setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),100)';
  const parent = `const fs=require('node:fs');const path=process.argv[1];if(fs.existsSync(path)){if(fs.readFileSync(path,'utf8')!=='retried'){fs.writeFileSync(path,'retried');process.exit(17)}process.exit(0)}const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)},path],{stdio:'ignore',detached:true,windowsHide:true});child.unref();setInterval(()=>{if(fs.existsSync(path))process.exit(1)},100)`;
  await writeFile(configPath, JSON.stringify({ ...config, acceptance: [...config.acceptance, { command: 'node', args: ['-e', parent, marker] }],
    completion: { idempotent: true, jobs: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] } }));
  const sha = value.commit();
  const failed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(failed, JSON.stringify(failed.error)).toMatchObject({ ok: false, candidateSha: sha, stage: 'acceptance', processes: { status: 'unknown' },
    effects: { deploymentCreate: 'accepted', deploymentPromote: 'not-attempted' },
    error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'CLOSURE_UNPROVEN', step: 'acceptance:1', exitCode: 1,
      termination: 'termination-failure', scopeReason: 'descendants-remained', empty: true, identified: true } } });
  const { runId, configSha256, prebuilt } = failed;
  if (!runId || !configSha256 || !prebuilt?.deploymentId) throw new Error('bound failed publication required');
  const binding = { runId, sha, configSha256, artifactSha256: prebuilt.artifactSha256, deploymentId: prebuilt.deploymentId };
  const slot = resolve(value.cwd, 'state/release-slot');
  const statePath = resolve(slot, 'state.json'), receiptPath = resolve(slot, 'latest-publish.json'), lockPath = resolve(slot, 'run.lock');
  const anchorPath = resolve(value.cwd, 'state/forge-vercel-release/managed.json');
  const state = await readFile(statePath, 'utf8'), receipt = await readFile(receiptPath, 'utf8');
  const lock = await readFile(lockPath, 'utf8'), anchor = await readFile(anchorPath, 'utf8');
  const terminal = await readFile(resolve(slot, 'terminal.json'), 'utf8');
  const recovery = await runRelease({ command: 'recover', cwd: value.cwd });
  expect(recovery).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'CLOSURE_UNPROVEN' } } });
  expect(await readFile(lockPath, 'utf8')).toBe(lock);
  const output = resolve(slot, 'checkout/.vercel/output/static/index.html'), sealed = await readFile(output);
  await writeFile(output, 'changed');
  try {
    const changed = await runRelease({ command: 'retire', cwd: value.cwd, runId });
    expect(changed).toMatchObject({ ok: false, error: { code: 'ARTIFACT_CHANGED' } });
    expect(await readFile(lockPath, 'utf8')).toBe(lock);
  } finally { await writeFile(output, sealed); }
  const retired = await runRelease({ command: 'retire', cwd: value.cwd, runId });
  expect(retired, JSON.stringify(retired.error)).toMatchObject({ ok: true, runId, processes: { status: 'closed' }, effects: failed.effects,
    retirement: { status: 'retired', historicalVerification: 'unknown', cessation: 'recorded-empty-drained-scope' } });
  const archivePath = resolve(slot, 'retired', `${runId}.json`), archiveText = await readFile(archivePath, 'utf8');
  const archive = JSON.parse(archiveText) as RetirementRecord;
  expect(archive).toMatchObject({ snapshot: { state, publish: receipt, lock, anchor }, final: { observation: { owner: 'inactive', processes: 'closed' } } });
  expect(archive.snapshot.terminal?.text).toBe(terminal);
  expect(await readFile(resolve(slot, 'terminal.json'), 'utf8')).toBe(terminal);
  const original = JSON.parse(state) as ManagedState, last = original.processes.at(-1);
  const closure = last?.closure, owned = closure?.ownedScope;
  if (!last || !closure || owned?.status !== 'unknown') throw new Error('native terminal result required');
  const withoutClosure = { ...last }; delete withoutClosure.closure;
  for (const replacement of [withoutClosure, { ...last, closure: { ...closure, ownedScope: { ...owned, empty: false } } }]) {
    const altered = { ...original, processes: [...original.processes.slice(0, -1), replacement] };
    expect(retirementCessation(altered, { ...archive.snapshot, state: JSON.stringify(altered) })).toBeUndefined();
  }
  for (const altered of [
    { ...original, effects: { ...original.effects, releasePush: 'unknown' as const } },
    { ...original, prebuilt: { ...prebuilt, artifactSha256: '0'.repeat(64) } },
  ]) expect(retirementCessation(altered, { ...archive.snapshot, state: JSON.stringify(altered) })).toBeUndefined();
  expect(retirementCessation(original, { ...archive.snapshot, anchor: '{}' })).toBeUndefined();
  await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const observed = await runRelease({ command: 'status', cwd: value.cwd, transport: value.transport });
  expect(observed, JSON.stringify(observed.error)).toMatchObject({ ok: true, runId, candidateSha: sha, configSha256, processes: { status: 'closed' }, prebuilt,
    retirement: { status: 'retired', origin: 'recorded-run-host', historicalVerification: 'unknown', cessation: 'recorded-empty-drained-scope', archivePath },
    recovery: { reportPath: receiptPath, reportExists: true, observation: { owner: 'inactive', processes: 'closed' } } });

  for (const command of ['check', 'publish', 'verify'] as const) {
    const blocked = await runRelease({ command, cwd: value.cwd, transport: value.transport });
    expect(blocked, JSON.stringify(blocked.error)).toMatchObject({ ok: false, error: { code: 'RECOVERY_REQUIRED', details: { reason: 'PREBUILT_ACCEPTANCE_RESUME_REQUIRED' } } });
  }
  const wrong = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport,
    resumePrebuilt: { ...binding, deploymentId: 'dpl_other' } });
  expect(wrong).toMatchObject({ ok: false, error: { code: 'RECOVERY_REQUIRED' } });
  expect(await readFile(statePath, 'utf8')).toBe(state);
  expect(await readFile(receiptPath, 'utf8')).toBe(receipt);
  expect(await readFile(anchorPath, 'utf8')).toBe(anchor);
  expect(await value.creates()).toBe(1);
  expect(value.promotions()).toBe(0);

  const retry = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport, resumePrebuilt: binding });
  expect(retry, JSON.stringify(retry.error)).toMatchObject({ ok: false, stage: 'acceptance', processes: { status: 'closed' },
    error: { code: 'ACCEPTANCE_FAILED' }, prebuilt });
  if (!retry.runId) throw new Error('closed retry receipt required');
  const blockedAfterRetry = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(blockedAfterRetry).toMatchObject({ ok: false, error: { code: 'RECOVERY_REQUIRED', details: { reason: 'PREBUILT_ACCEPTANCE_RESUME_REQUIRED' } } });
  value.hooks.promote = () => { throw new ReleaseError('VERCEL_API', { reason: 'PROMOTION_RESPONSE_LOST' }); };
  const resumed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport,
    resumePrebuilt: { ...binding, runId: retry.runId } });
  expect(resumed, JSON.stringify(resumed.error)).toMatchObject({ ok: false, candidateSha: sha, stage: 'promote',
    prebuilt: { deploymentId: binding.deploymentId, artifactSha256: binding.artifactSha256, acceptanceVerified: true,
      promoteEffect: 'unknown', promotionVerified: false }, processes: { status: 'closed' } });
  expect(resumed.runId).not.toBe(runId);
  expect(resumed.steps.map(step => step.name)).toEqual(expect.arrayContaining(['acceptance:0', 'acceptance:1']));
  expect(resumed.steps.map(step => step.name)).not.toContain('prebuilt-create');
  const verified = await runRelease({ command: 'verify', cwd: value.cwd, sha, retryCompletion: true, transport: value.transport });
  expect(verified, JSON.stringify(verified.error)).toMatchObject({ ok: true, deployment: { id: binding.deploymentId },
    prebuilt: { promotionVerified: true, artifactSha256: binding.artifactSha256 }, completion: { status: 'completed' } });
  expect(verified.steps.map(step => step.name)).toEqual(expect.arrayContaining(['acceptance:0', 'acceptance:1', 'completion:0']));
  expect(await value.creates()).toBe(1);
  expect(value.promotions()).toBe(1);
  expect(await readFile(archivePath, 'utf8')).toBe(archiveText);
  const checked = await runRelease({ command: 'check', cwd: value.cwd, transport: value.transport });
  expect(checked, JSON.stringify(checked.error)).toMatchObject({ ok: true });
}, 120_000);
