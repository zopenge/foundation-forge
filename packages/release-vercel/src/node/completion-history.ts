import { resolve } from 'node:path';
import type { ReleaseCompletionState } from '../contracts.js';
import type { FrozenSource, ManagedPaths, ManagedSession, ManagedSlot, ManagedState } from './release-context.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { parseCompletionState } from './completion-state.js';
import { hasVerifiedManagedClosure, hasVerifiedManagedStop } from './managed-closure.js';
import { assertManagedHistory, captureManagedHistory, historyFileLimit } from './managed-history.js';
import { readManagedDisposition } from './managed-disposition.js';
import { parseRetirementRecord, readRetirementRecord, type RetirementRecord } from './retirement-record.js';
import { parseManagedState } from './managed-state.js';
import { assertMetadataFile } from './managed-metadata.js';
import { assertHistoricalSource } from './managed-recovery.js';
import { recoveryCommand } from './release-commands.js';
import { parseCompletionInput } from './completion-input.js';

export interface CompletionSnapshot {
  readonly origin: ManagedState;
  readonly current: ManagedState;
  readonly completion: ReleaseCompletionState;
  readonly records: readonly ManagedState[];
  readonly ceased: readonly ManagedState[];
}
function invalid(reason: string): never { throw new ReleaseError('SLOT_STATE', { reason }); }
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** final只证明原实例停止；原UNKNOWN state、attempt和云效果仍原样保留。 */
function retiredCompletion(value: RetirementRecord): ManagedState {
  const evidence = parseRetirementRecord(value);
  if (!evidence.final) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_INCOMPLETE' });
  const input: unknown = JSON.parse(evidence.snapshot.state), source = record(input).source as FrozenSource;
  const state = parseManagedState(input, source, evidence.slotId);
  const anchor = record(JSON.parse(evidence.snapshot.anchor)), latest = record(anchor.latestPublish);
  const owner = record(JSON.parse(evidence.snapshot.owner)), lock = record(JSON.parse(evidence.snapshot.lock));
  if (!state.completion || state.runId !== evidence.runId || state.slotId !== evidence.slotId
    || [anchor, owner].some(value => value.slotId !== state.slotId || value.sourceRoot !== source.root || value.configPath !== source.configPath)
    || owner.repository !== source.config.git.repository || typeof latest.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(latest.runId)
    || latest.sha !== source.sha || latest.configSha256 !== source.configSha256
    || lock.runId !== state.runId || lock.pid !== state.coordinator.pid || !same(lock.identity, state.coordinator)) invalid('COMPLETION_RETIREMENT_BINDING');
  return state;
}

/** 尝试必须沿同一原始发布追加；时间戳、布尔值或较大的计数本身都不是完成证明。 */
export function selectCompletionSnapshots(states: readonly ManagedState[], retirements: readonly RetirementRecord[] = []): readonly CompletionSnapshot[] {
  const ceased = retirements.map(retiredCompletion);
  const groups = new Map<string, ManagedState[]>();
  for (const state of states) {
    const completion = parseCompletionState(state.completion, state.source, state.prebuilt);
    parseCompletionInput(state.completionInput, completion !== undefined);
    if (!completion) continue;
    const previous = groups.get(completion.publicationRunId) ?? [];
    previous.push(state); groups.set(completion.publicationRunId, previous);
  }
  const result: CompletionSnapshot[] = [];
  for (const [runId, records] of groups) {
    const origin = records.find(state => state.runId === runId && state.command === 'publish');
    if (!origin?.completion) invalid('COMPLETION_ORIGIN_MISSING');
    const current = records.reduce((latest, state) => (state.completion?.attempts.length ?? 0) > (latest.completion?.attempts.length ?? 0) ? state : latest);
    const completion = current.completion;
    if (!completion) invalid('COMPLETION_BINDING');
    for (const state of records) {
      const value = state.completion;
      if (!value || state.slotId !== origin.slotId || state.source.root !== origin.source.root || state.source.configPath !== origin.source.configPath
        || !same(value.context, completion.context) || !same(state.completionInput, origin.completionInput)
        || !same(value.attempts, completion.attempts.slice(0, value.attempts.length)))
        invalid('COMPLETION_HISTORY_FORK');
    }
    if (completion.status === 'completed') {
      const attempt = completion.attempts.at(-1);
      const proved = attempt && records.some(state => state.runId === attempt.runId && state.completion?.status === 'completed'
        && same(state.completion.attempts, completion.attempts) && state.prebuilt?.promotionVerified === true
        && attempt.jobs.every(job => state.processes.some(command => command.id === job.commandId && command.name === `completion:${job.index}`
          && /^[a-f0-9]{64}$/u.test(command.terminalSha256 ?? '') && hasVerifiedManagedClosure(command) && command.closure?.exitCode === 0)));
      if (!proved) invalid('COMPLETION_PROOF_MISSING');
    }
    const stopped = ceased.filter(state => records.some(record => same(record, state)));
    for (const state of stopped) {
      const proof = retirements.find(record => record.runId === state.runId && same(JSON.parse(record.snapshot.state), state));
      const latest = record(record(JSON.parse(proof?.snapshot.anchor ?? 'null')).latestPublish);
      if (!records.some(published => published.command === 'publish' && published.runId === latest.runId
        && published.source.sha === latest.sha && published.source.configSha256 === latest.configSha256)) invalid('COMPLETION_RETIREMENT_BINDING');
    }
    result.push({ origin, current, completion, records, ceased: stopped });
  }
  return result;
}
export function assertCompletionRetryStopped(snapshot: CompletionSnapshot): void {
  const attempts = snapshot.completion.attempts;
  const required = attempts.length ? attempts.map(attempt => ({ runId: attempt.runId, attempt })) : [{ runId: snapshot.origin.runId, attempt: undefined }];
  for (const entry of required) {
    const stopped = snapshot.records.some(state => state.runId === entry.runId
      && (!entry.attempt || state.completion?.attempts.some(attempt => same(attempt, entry.attempt)))
      && (snapshot.ceased.some(retired => same(retired, state)) || state.processes.every(hasVerifiedManagedStop)
        && (!entry.attempt || entry.attempt.jobs.every(job => !job.commandId || state.processes.some(command => command.id === job.commandId
          && command.name === `completion:${job.index}` && /^[a-f0-9]{64}$/u.test(command.terminalSha256 ?? '') && hasVerifiedManagedStop(command))))));
    if (!stopped) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'COMPLETION_CLOSURE_UNPROVEN', runId: entry.runId });
  }
}

export async function readCompletionSnapshots(paths: ManagedPaths, slotId: string, active?: ManagedState, signal?: AbortSignal): Promise<readonly CompletionSnapshot[]> {
  assertActive(signal);
  if (active) await assertManagedHistory(paths, active);
  const references = await captureManagedHistory(paths), states: ManagedState[] = active ? [active] : [], retirements: RetirementRecord[] = [];
  for (const reference of references) {
    assertActive(signal);
    const path = resolve(paths.slotRoot, reference.path);
    await assertMetadataFile(path, reference.file, historyFileLimit);
    let state: ManagedState;
    if (reference.path.startsWith('history/')) {
      const archive = await readManagedDisposition(paths, reference.path.slice(8, -5));
      if (!archive) return invalid('COMPLETION_HISTORY_MISSING');
      state = archive.stopped;
    } else {
      const retired = await readRetirementRecord(path, paths);
      if (!retired) return invalid('COMPLETION_HISTORY_MISSING');
      const value: unknown = JSON.parse(retired.snapshot.state);
      if (record(value).completion === undefined && record(record(record(value).source).config).completion === undefined) {
        await assertMetadataFile(path, reference.file, historyFileLimit); continue;
      }
      if (!retired.final) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_INCOMPLETE' });
      state = parseManagedState(value, record(value).source as FrozenSource, slotId);
      if (retired.runId !== state.runId || retired.slotId !== slotId || reference.path !== `retired/${state.runId}.json`)
        invalid('COMPLETION_RETIREMENT_BINDING');
      if (!state.completion) { await assertMetadataFile(path, reference.file, historyFileLimit); continue; }
      state = retiredCompletion(retired);
      retirements.push(retired);
    }
    if (state.completion && (state.slotId !== slotId || state.source.root !== paths.sourceRoot || state.source.config.source.mode !== 'managed-commit'
      || resolve(state.source.root, state.source.config.source.slotPath) !== paths.slotRoot)) invalid('COMPLETION_HISTORY_LOCATION');
    await assertMetadataFile(path, reference.file, historyFileLimit); states.push(state);
  }
  assertActive(signal); return selectCompletionSnapshots(states, retirements);
}

/** 原锁内、任何新 state/checkout 写入之前准入；只有原候选 verify 能接续 pending 输入。 */
export async function admitCompletionSlot(paths: ManagedPaths, slotId: string, source: FrozenSource,
  command: ManagedSession['command'] | undefined, active?: ManagedState, signal?: AbortSignal): Promise<ManagedSlot['completionResume']> {
  const snapshots = await readCompletionSnapshots(paths, slotId, active, signal);
  const matches = (snapshot: CompletionSnapshot) => snapshot.origin.source.sha === source.sha
    && snapshot.origin.source.configSha256 === source.configSha256 && snapshot.origin.source.configPath === source.configPath;
  const pending = snapshots.filter(snapshot => snapshot.completion.status !== 'completed');
  for (const snapshot of pending) {
    await assertHistoricalSource(snapshot.origin.source, signal);
    if (pending.length > 1 || command !== 'verify' || !matches(snapshot)) throw new ReleaseError('RECOVERY_REQUIRED', {
      reason: 'COMPLETION_PENDING', runId: snapshot.completion.publicationRunId, sourceSha: snapshot.origin.source.sha,
      nextCommand: recoveryCommand('verify --retry-completion', snapshot.origin.source) });
    assertCompletionRetryStopped(snapshot);
  }
  const selected = snapshots.filter(matches);
  if (selected.length > 1) return invalid('COMPLETION_BINDING_AMBIGUOUS');
  const snapshot = selected[0];
  if (!snapshot) return;
  if (!snapshot.current.prebuilt || !snapshot.current.completionInput) return invalid('COMPLETION_BINDING');
  return { prebuilt: structuredClone(snapshot.current.prebuilt), completion: { ...structuredClone(snapshot.completion),
    ...(snapshot.completion.status === 'running' ? { status: 'unknown' as const } : {}) }, input: structuredClone(snapshot.current.completionInput) };
}
