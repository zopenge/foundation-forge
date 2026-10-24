import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReleaseRecoveryObservation } from '../contracts.js';
import type { FileIdentity, ManagedPaths, ManagedState } from './release-context.js';
import { assertPathChain, fileIdentity, measureManagedUsage, readBoundedJson, readBoundedText, sameIdentity } from './managed-io.js';
import { record, ReleaseError } from './errors.js';
import { hasSubsequentBoot, validRetirementHost, type RetirementHost } from './retirement-host.js';

export interface RetirementSnapshot {
  readonly state: string; readonly lock: string; readonly anchor: string; readonly owner: string;
  readonly check: string | null; readonly publish: string | null;
  readonly identities: Readonly<Record<'state' | 'lock' | 'anchor' | 'owner', FileIdentity>>;
}
export interface RetirementRecord {
  readonly schemaVersion: 1; readonly kind: 'interrupted-run-retirement';
  readonly runId: string; readonly slotId: string;
  readonly snapshot: RetirementSnapshot; readonly snapshotSha256: string;
  readonly origin: 'operator-confirmed-origin' | 'recorded-run-host';
  readonly host: RetirementHost; readonly preparedAt: string;
  readonly checksum: string;
  readonly final?: { readonly host: RetirementHost; readonly retiredAt: string; readonly observation: ReleaseRecoveryObservation };
}
export const retirementDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export const sealRetirementRecord = (value: Omit<RetirementRecord, 'checksum'>): RetirementRecord => ({ ...value, checksum: retirementDigest({ ...value, checksum: undefined }) });
const archiveLimit = 8_388_608;
export const retirementArchivePath = (paths: ManagedPaths, runId: string): string => resolve(paths.slotRoot, 'retired', `${runId}.json`);
export async function captureRetirementSnapshot(paths: ManagedPaths): Promise<RetirementSnapshot> {
  const names = { state: paths.statePath, lock: paths.lockPath, anchor: paths.anchorPath, owner: paths.ownershipPath };
  const read = async (key: keyof typeof names) => {
    const path = names[key], identity = await fileIdentity(path), text = await readBoundedText(path);
    if (text === undefined || !sameIdentity(identity, await fileIdentity(path))) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_INPUT_CHANGED' });
    return { text, identity };
  };
  const state = await read('state'), lock = await read('lock'), anchor = await read('anchor'), owner = await read('owner');
  return { state: state.text, lock: lock.text, anchor: anchor.text, owner: owner.text,
    check: await readBoundedText(resolve(paths.slotRoot, 'latest-check.json')) ?? null,
    publish: await readBoundedText(resolve(paths.slotRoot, 'latest-publish.json')) ?? null,
    identities: { state: state.identity, lock: lock.identity, anchor: anchor.identity, owner: owner.identity } };
}
export function parseRetirementRecord(value: unknown): RetirementRecord {
  const item = record(value), snapshot = record(item.snapshot), identities = record(snapshot.identities), final = item.final === undefined ? undefined : record(item.final);
  if (typeof item.checksum !== 'string' || item.checksum !== retirementDigest({ ...item, checksum: undefined })) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_CHECKSUM' });
  if (item.schemaVersion !== 1 || item.kind !== 'interrupted-run-retirement' || typeof item.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.runId)
    || typeof item.slotId !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.slotId) || !['operator-confirmed-origin', 'recorded-run-host'].includes(String(item.origin))
    || !validRetirementHost(item.host) || typeof item.preparedAt !== 'string' || !Number.isFinite(Date.parse(item.preparedAt))
    || !['state', 'lock', 'anchor', 'owner'].every(key => typeof snapshot[key] === 'string' && sameIdentity(record(identities[key]), record(identities[key])))
    || !['check', 'publish'].every(key => snapshot[key] === null || typeof snapshot[key] === 'string')
    || item.snapshotSha256 !== retirementDigest(snapshot)) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_RECORD' });
  if (final && (!validRetirementHost(final.host) || !hasSubsequentBoot(item.host, final.host)
    || typeof final.retiredAt !== 'string' || !Number.isFinite(Date.parse(final.retiredAt))
    || record(final.observation).owner !== 'inactive' || !['closed', 'unknown'].includes(String(record(final.observation).processes))
    || !['developmentRef', 'releaseRef'].every(key => ['candidate', 'before', 'superseded', 'diverged', 'unknown'].includes(String(record(record(final.observation)[key]).relation))))) {
    throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_CESSATION' });
  }
  return value as RetirementRecord;
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
