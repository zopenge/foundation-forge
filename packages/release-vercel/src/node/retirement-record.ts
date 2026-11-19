import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FrozenSource, ManagedPaths, ManagedState } from './managed-state-contracts.js';
import type { RetirementRecord, RetirementSnapshot } from './retirement-contracts.js';
import { assertPathChain, fileIdentity, measureManagedUsage, readBoundedJson, readBoundedText, sameIdentity } from './managed-io.js';
import { record, ReleaseError } from './errors.js';
import { validRetirementHost } from './retirement-host.js';
import { isUnstartedRetirementSnapshot } from './unstarted-retirement.js';
import { parseManagedState } from './managed-state.js';
import { hasVerifiedManagedStop } from './managed-closure.js';
import { assertMetadataFile, inspectMetadataFile, metadataDigest, terminalLimit } from './managed-metadata.js';
import { hasUnresolvedPrebuiltEffect } from './prebuilt-recovery.js';

export const retirementDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export const sealRetirementRecord = (value: Omit<RetirementRecord, 'checksum'>): RetirementRecord => ({ ...value, checksum: retirementDigest({ ...value, checksum: undefined }) });
const archiveLimit = 8_388_608;

export const hasUnresolvedRetirementEffects = (state: ManagedState): boolean =>
  state.pendingPush !== undefined || Object.values(state.effects).includes('unknown') || hasUnresolvedPrebuiltEffect(state);

/** 只从已持久化的绑定见证择取本地退役依据；未决副作用走原发布恢复路径。 */
export function retirementCessation(state: ManagedState, snapshot: RetirementSnapshot): NonNullable<RetirementRecord['final']>['cessation'] | undefined {
  if (hasUnresolvedRetirementEffects(state)) return undefined;
  if (state.processes.every(hasVerifiedManagedStop)) return 'recorded-stopped-scopes';
  if (isUnstartedRetirementSnapshot(snapshot)) return 'recorded-empty-unstarted-scope';
}
export const retirementArchivePath = (paths: ManagedPaths, runId: string): string => resolve(paths.slotRoot, 'retired', `${runId}.json`);
export async function captureRetirementSnapshot(paths: ManagedPaths): Promise<RetirementSnapshot> {
  const names = { state: paths.statePath, lock: paths.lockPath, anchor: paths.anchorPath, owner: paths.ownershipPath };
  const read = async (key: keyof typeof names) => {
    const path = names[key], identity = await fileIdentity(path), text = await readBoundedText(path);
    if (text === undefined || !sameIdentity(identity, await fileIdentity(path))) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_INPUT_CHANGED' });
    return { text, identity };
  };
  const state = await read('state'), lock = await read('lock'), anchor = await read('anchor'), owner = await read('owner');
  const terminalPath = resolve(paths.slotRoot, 'terminal.json');
  const file = await inspectMetadataFile(terminalPath, terminalLimit), text = file && await readBoundedText(terminalPath, terminalLimit);
  if (file && (typeof text !== 'string' || metadataDigest(text) !== file.sha256))
    throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_INPUT_CHANGED', entry: 'terminal' });
  return { state: state.text, lock: lock.text, anchor: anchor.text, owner: owner.text,
    check: await readBoundedText(resolve(paths.slotRoot, 'latest-check.json')) ?? null,
    publish: await readBoundedText(resolve(paths.slotRoot, 'latest-publish.json')) ?? null,
    ...(file && typeof text === 'string' ? { terminal: { text, file } } : {}),
    identities: { state: state.identity, lock: lock.identity, anchor: anchor.identity, owner: owner.identity } };
}
export function parseRetirementRecord(value: unknown): RetirementRecord {
  const item = record(value), snapshot = record(item.snapshot), identities = record(snapshot.identities), final = item.final === undefined ? undefined : record(item.final);
  if (typeof item.checksum !== 'string' || item.checksum !== retirementDigest({ ...item, checksum: undefined })) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_CHECKSUM' });
  if (item.schemaVersion !== 1 || item.kind !== 'interrupted-run-retirement' || typeof item.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.runId)
    || typeof item.slotId !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.slotId) || item.origin !== 'recorded-run-host'
    || !validRetirementHost(item.host) || typeof item.preparedAt !== 'string' || !Number.isFinite(Date.parse(item.preparedAt))
    || !['state', 'lock', 'anchor', 'owner'].every(key => typeof snapshot[key] === 'string' && sameIdentity(record(identities[key]), record(identities[key])))
    || !['check', 'publish'].every(key => snapshot[key] === null || typeof snapshot[key] === 'string')
    || item.snapshotSha256 !== retirementDigest(snapshot)) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_RECORD' });
  const evidence = value as RetirementRecord;
  if (snapshot.terminal !== undefined) {
    const terminal = record(snapshot.terminal), file = record(terminal.file);
    if (typeof terminal.text !== 'string' || Buffer.byteLength(terminal.text) > terminalLimit || metadataDigest(terminal.text) !== file.sha256
      || !sameIdentity(record(file.identity), record(file.identity))) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_TERMINAL' });
  }
  let original: Record<string, unknown>;
  try { original = record(JSON.parse(evidence.snapshot.state)); }
  catch { throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_STATE_BINDING' }); }
  if (original.schemaVersion !== 3 || !Array.isArray(original.history) || !validRetirementHost(original.host)
    || retirementDigest(original.host) !== retirementDigest(evidence.host)) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_STATE_BINDING' });
  if (final) {
    const originalState = parseManagedState(original, original.source as FrozenSource, evidence.slotId);
    if (!validRetirementHost(final.host) || originalState.runId !== evidence.runId
      || final.host.hostId !== evidence.host.hostId || final.host.platform !== evidence.host.platform
      || final.cessation === undefined || final.cessation !== retirementCessation(originalState, evidence.snapshot)
      || typeof final.retiredAt !== 'string' || !Number.isFinite(Date.parse(final.retiredAt))
      || record(final.observation).owner !== 'inactive'
      || record(final.observation).processes !== (final.cessation === 'recorded-stopped-scopes' ? 'closed' : 'unknown')
      || !['developmentRef', 'releaseRef'].every(key => ['candidate', 'before', 'superseded', 'diverged', 'unknown'].includes(String(record(record(final.observation)[key]).relation)))) {
      throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_CESSATION' });
    }
  }
  return evidence;
}
export async function readRetirementRecord(path: string, paths: ManagedPaths): Promise<RetirementRecord | undefined> {
  await assertPathChain(paths.slotRoot, path);
  const value = await readBoundedJson(path, archiveLimit);
  return value === undefined ? undefined : parseRetirementRecord(value);
}
export async function assertRetirementSnapshot(paths: ManagedPaths, evidence: RetirementRecord, includeLock = true): Promise<void> {
  const entries = { state: paths.statePath, anchor: paths.anchorPath, owner: paths.ownershipPath, ...(includeLock ? { lock: paths.lockPath } : {}) };
  for (const [key, path] of Object.entries(entries)) {
    const name = key as keyof RetirementSnapshot['identities'];
    if (await readBoundedText(path) !== evidence.snapshot[name] || !sameIdentity(await fileIdentity(path), evidence.snapshot.identities[name])) {
      throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_INPUT_CHANGED', entry: key });
    }
  }
  for (const name of ['check', 'publish'] as const) if ((await readBoundedText(resolve(paths.slotRoot, `latest-${name}.json`)) ?? null) !== evidence.snapshot[name]) {
    throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_INPUT_CHANGED', entry: name });
  }
  await assertMetadataFile(resolve(paths.slotRoot, 'terminal.json'), evidence.snapshot.terminal?.file ?? null, terminalLimit);
}
export async function hasFinalizedRetirement(paths: ManagedPaths, state: ManagedState): Promise<boolean> {
  const evidence = await readRetirementRecord(retirementArchivePath(paths, state.runId), paths);
  if (!evidence) return false;
  if (!evidence.final || evidence.runId !== state.runId || evidence.slotId !== state.slotId) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_BINDING' });
  const original = record(JSON.parse(evidence.snapshot.state));
  if (original.runId !== state.runId || original.slotId !== state.slotId || JSON.stringify(original) !== JSON.stringify(state)) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_STATE_BINDING' });
  await assertRetirementSnapshot(paths, evidence, false); return true;
}
/** 随机排他暂存文件避免旧进程半写文件成为续验依赖；所有字节仍计入同一槽位预算。 */
export async function writeRetirementJson(path: string, value: unknown, paths: ManagedPaths, state: ManagedState, guard: () => Promise<void>): Promise<void> {
  if (state.source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), config = state.source.config.source;
  if (bytes.length > archiveLimit) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'RETIREMENT_METADATA_LIMIT' });
  await guard(); await assertPathChain(paths.slotRoot, path);
  const work = resolve(paths.slotRoot, 'retirement-work'); await assertPathChain(paths.slotRoot, work); await mkdir(work, { recursive: true });
  const usage = await measureManagedUsage(paths);
  if (usage.bytes + bytes.length > config.maxBytes || usage.freeBytes - bytes.length < config.minFreeBytes) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'RETIREMENT_ADMISSION' });
  const temporary = resolve(work, `${randomUUID()}.next`), handle = await open(temporary, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } catch (error) { await handle.close(); await unlink(temporary); throw error; }
  await handle.close();
  try { await guard(); await rename(temporary, path); }
  catch (error) { await unlink(temporary); throw error; }
}
