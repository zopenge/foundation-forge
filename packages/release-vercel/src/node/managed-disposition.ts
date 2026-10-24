import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ReleaseRecoveryObservation, ReleaseReport } from '../contracts.js';
import type { ManagedPaths, ManagedState } from './release-context.js';
import { record, ReleaseError } from './errors.js';
import { assertPathChain, atomicJson, readBoundedJson, readBoundedText } from './managed-io.js';
import { assertMetadataFile, assertMetadataPaths, inspectMetadataFile, metadataDigest, type MetadataFile } from './managed-metadata.js';
import { hasVerifiedManagedStop } from './managed-closure.js';
import { parseManagedReceipt, parseManagedState, summarizeReport } from './managed-state.js';

const historyLimit = 8_388_608;
const names = (paths: ManagedPaths) => ({ state: paths.statePath, owner: paths.ownershipPath, anchor: paths.anchorPath,
  lock: paths.lockPath, terminal: resolve(paths.slotRoot, 'terminal.json'), check: resolve(paths.slotRoot, 'latest-check.json'), publish: resolve(paths.slotRoot, 'latest-publish.json') });
type Entry = keyof ReturnType<typeof names>;
export interface ManagedDisposition {
  readonly schemaVersion: 1; readonly kind: 'managed-run-disposition'; readonly runId: string; readonly slotId: string;
  readonly snapshot: Readonly<Record<Entry, string | null>>;
  readonly files: Readonly<Record<Entry, MetadataFile | null>>;
  readonly stopped: ManagedState;
  readonly local: 'release-ready'; readonly recordedAt: string;
  readonly observation?: ReleaseRecoveryObservation;
  readonly outcome?: ReleaseReport;
  readonly checksum: string;
}
export const dispositionPath = (paths: ManagedPaths, runId: string): string => resolve(paths.slotRoot, 'history', `${runId}.json`);
export function parseManagedDisposition(value: unknown): ManagedDisposition {
  const item = record(value), { checksum, ...body } = item;
  if (typeof checksum !== 'string' || metadataDigest(JSON.stringify(body)) !== checksum) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_CHECKSUM' });
  const snapshot = record(item.snapshot), files = record(item.files), stopped = record(item.stopped);
  if (item.schemaVersion !== 1 || item.kind !== 'managed-run-disposition' || item.local !== 'release-ready'
    || typeof item.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.runId) || item.runId !== stopped.runId || item.slotId !== stopped.slotId
    || typeof item.recordedAt !== 'string' || !Number.isFinite(Date.parse(item.recordedAt))) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_BINDING' });
  for (const key of ['state', 'owner', 'anchor', 'lock', 'terminal', 'check', 'publish']) {
    const file = record(files[key]), identity = record(file.identity);
    if (snapshot[key] === null && files[key] === null) continue;
    if (typeof snapshot[key] !== 'string' || file.sha256 !== metadataDigest(snapshot[key])
      || ![identity.dev, identity.ino].every(part => typeof part === 'string' && /^\d+$/u.test(part))) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_FILE' });
  }
  if (typeof snapshot.state !== 'string' || typeof snapshot.owner !== 'string') throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_STATE' });
  const result = value as ManagedDisposition;
  const original = parseManagedState(JSON.parse(snapshot.state), result.stopped.source, result.slotId);
  parseManagedState(result.stopped, original.source, original.slotId);
  if (result.outcome) {
    parseManagedReceipt({ schemaVersion: 2, slotId: result.slotId, source: original.source, report: result.outcome }, original.source, result.slotId);
    if (result.outcome.runId !== result.runId) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_OUTCOME' });
  }
  const commandsMatch = original.processes.length === result.stopped.processes.length && original.processes.every((command, index) => {
    const stopped = result.stopped.processes[index];
    if (!stopped || command.id !== stopped.id || command.name !== stopped.name) return false;
    if (index < original.processes.length - 1) return JSON.stringify(command) === JSON.stringify(stopped);
    return (command.scope === undefined || JSON.stringify(command.scope) === JSON.stringify(stopped.scope))
      && (command.identity === undefined || JSON.stringify(command.identity) === JSON.stringify(stopped.identity))
      && (command.terminalSha256 === undefined || command.terminalSha256 === stopped.terminalSha256)
      && JSON.stringify(command.descendants) === JSON.stringify(stopped.descendants);
  });
  if (original.runId !== result.runId || JSON.stringify({ ...original, processes: [] }) !== JSON.stringify({ ...result.stopped, processes: [] })
    || !commandsMatch || !result.stopped.processes.every(hasVerifiedManagedStop)) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_STOP' });
  return result;
}
export async function readManagedDisposition(paths: ManagedPaths, runId: string): Promise<ManagedDisposition | undefined> {
  const path = dispositionPath(paths, runId); await assertMetadataPaths(paths); await assertPathChain(paths.slotRoot, path);
  const value = await readBoundedJson(path, historyLimit);
  return value === undefined ? undefined : parseManagedDisposition(value);
}
export async function assertDispositionSnapshot(paths: ManagedPaths, evidence: ManagedDisposition, includeLock = true): Promise<void> {
  await assertMetadataPaths(paths);
  for (const [key, path] of Object.entries(names(paths))) {
    if (key === 'lock' && !includeLock) continue;
    await assertMetadataFile(path, evidence.files[key as Entry]);
  }
}
export async function hasManagedDisposition(paths: ManagedPaths, state: ManagedState): Promise<boolean> {
  const evidence = await readManagedDisposition(paths, state.runId);
  if (!evidence) return false;
  if (evidence.slotId !== state.slotId || JSON.stringify(JSON.parse(evidence.snapshot.state ?? 'null')) !== JSON.stringify(state)) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_STATE_BINDING' });
  await assertDispositionSnapshot(paths, evidence, false); return true;
}
/** 保存原始结果和只读归并的停止事实；历史副作用不因本地解锁而改写。 */
export async function archiveManagedDisposition(paths: ManagedPaths, original: ManagedState, stopped: ManagedState, guard: () => Promise<void>, observation?: ReleaseRecoveryObservation, omitLock = false, outcome?: ReleaseReport): Promise<ManagedDisposition> {
  await guard();
  const existing = await readManagedDisposition(paths, original.runId);
  if (existing) { await hasManagedDisposition(paths, original); return existing; }
  const entries = await Promise.all(Object.entries(names(paths)).map(async ([key, path]) => {
    const witness = key === 'lock' && omitLock ? null : await inspectMetadataFile(path);
    const text = witness ? await readBoundedText(path) ?? null : null;
    if (witness && (text === null || metadataDigest(text) !== witness.sha256)) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_INPUT_CHANGED' });
    if (!(key === 'lock' && omitLock)) await assertMetadataFile(path, witness);
    return [key, text, witness] as const;
  }));
  const body = { schemaVersion: 1 as const, kind: 'managed-run-disposition' as const, runId: original.runId, slotId: original.slotId,
    snapshot: Object.fromEntries(entries.map(([key, text]) => [key, text])) as Record<Entry, string | null>,
    files: Object.fromEntries(entries.map(([key, , witness]) => [key, witness])) as Record<Entry, MetadataFile | null>,
    stopped, local: 'release-ready' as const, recordedAt: new Date().toISOString(), ...(observation ? { observation } : {}), ...(outcome ? { outcome: summarizeReport(outcome) } : {}) };
  const evidence = parseManagedDisposition({ ...body, checksum: metadataDigest(JSON.stringify(body)) });
  if (JSON.stringify(JSON.parse(evidence.snapshot.state ?? 'null')) !== JSON.stringify(original)) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_STATE_CHANGED' });
  const config = original.source.config.source; if (config.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const path = dispositionPath(paths, original.runId); await assertPathChain(paths.slotRoot, path); await mkdir(dirname(path), { recursive: true });
  const writeGuard = async () => { await guard(); await assertDispositionSnapshot(paths, evidence, !omitLock); };
  await atomicJson(path, evidence, historyLimit, paths, writeGuard, config.maxBytes, config.minFreeBytes);
  await writeGuard(); return evidence;
}
