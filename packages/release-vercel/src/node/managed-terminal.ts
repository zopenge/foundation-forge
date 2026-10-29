import { resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { ManagedCommand, ManagedPaths, ManagedSlot, ManagedState } from './release-context.js';
import { record, ReleaseError } from './errors.js';
import { assertMetadataFile, assertMetadataPaths, inspectMetadataFile, metadataDigest, sameMetadataFile, terminalLimit, writeReservedMetadata, type MetadataFile } from './managed-metadata.js';
import { readRetirementHost, validRetirementHost, type RetirementHost } from './retirement-host.js';
import { hasObservationStopWitness, hasVerifiedManagedStop } from './managed-closure.js';
import { matchesObservationBinding } from './managed-observation.js';
import { pathExists, readBoundedJson } from './managed-io.js';
import { parseManagedState } from './managed-state.js';

export interface ManagedTerminal {
  readonly schemaVersion: 1; readonly kind: 'managed-terminal'; readonly runId: string; readonly slotId: string;
  readonly sourceSha: string; readonly configSha256: string; readonly host: RetirementHost;
  readonly files: { readonly owner: MetadataFile | null; readonly anchor: MetadataFile | null; readonly lock: MetadataFile | null; readonly state: MetadataFile | null };
  readonly stateTransition?: { readonly to: MetadataFile };
  readonly command: ManagedCommand; readonly proofSha256: string; readonly checksum: string;
}
type TerminalBody = Omit<ManagedTerminal, 'checksum' | 'proofSha256'>;
const proofDigest = (body: TerminalBody): string => metadataDigest(JSON.stringify({ schemaVersion: body.schemaVersion, kind: body.kind,
  runId: body.runId, slotId: body.slotId, sourceSha: body.sourceSha, configSha256: body.configSha256, host: body.host,
  files: { owner: body.files.owner, anchor: body.files.anchor, lock: body.files.lock }, command: body.command }));
function sealTerminal(body: TerminalBody): ManagedTerminal {
  const value = { ...body, proofSha256: proofDigest(body) };
  return { ...value, checksum: metadataDigest(JSON.stringify(value)) };
}
function metadataFile(value: unknown): MetadataFile | null {
  if (value === null) return null;
  const item = record(value), identity = record(item.identity);
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
    || ![identity.dev, identity.ino].every(part => typeof part === 'string' && /^\d{1,64}$/u.test(part))) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_FILE_BINDING' });
  return value as MetadataFile;
}
export interface TerminalWriter {
  assertOwned(): Promise<void>;
  prepareState(prepared: MetadataFile): Promise<void>;
  acceptState(state: ManagedState): Promise<void>;
  write(command: ManagedCommand): Promise<string>;
}
/** 仅在停止事实已归档且持有恢复互斥时，丢弃尚未提交的精确 state 暂存文件。 */
export async function discardPreparedState(paths: ManagedPaths, terminal: ManagedTerminal | undefined, guard: () => Promise<void>): Promise<void> {
  const temporary = resolve(paths.slotRoot, '.state.json.next');
  await guard();
  if (!await pathExists(temporary)) return;
  if (!terminal?.stateTransition || !sameMetadataFile(await inspectMetadataFile(paths.statePath), terminal.files.state)
    || JSON.stringify(await readBoundedJson(resolve(paths.slotRoot, 'terminal.json'), terminalLimit)) !== JSON.stringify(terminal)) {
    throw new ReleaseError('SLOT_STATE', { reason: 'METADATA_TEMP_UNPROVEN' });
  }
  await assertMetadataFile(temporary, terminal.stateTransition.to);
  await guard(); await assertMetadataFile(temporary, terminal.stateTransition.to);
  await unlink(temporary);
}
/** 仅读取并在内存归并；原始状态、失败结果和远端副作用不改写。 */
export async function restoreManagedTerminal(paths: ManagedPaths, state: ManagedState, options: { allowReleasedLock?: boolean; signal?: AbortSignal } = {}): Promise<{ state: ManagedState; terminal?: ManagedTerminal }> {
  await assertMetadataPaths(paths);
  if (state.processes.length === 0) return { state };
  const path = resolve(paths.slotRoot, 'terminal.json'), original = await inspectMetadataFile(path, terminalLimit);
  const value = await readBoundedJson(path, terminalLimit);
  if (value === undefined) {
    if (state.processes.at(-1)?.terminalSha256) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_MISSING' });
    return { state };
  }
  const { checksum, ...envelope } = record(value), { proofSha256, ...body } = envelope;
  if (typeof checksum !== 'string' || metadataDigest(JSON.stringify(envelope)) !== checksum) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_CHECKSUM' });
  const files = record(body.files), command = record(body.command);
  for (const key of ['owner', 'anchor', 'lock', 'state']) metadataFile(files[key]);
  if (body.stateTransition !== undefined && !metadataFile(record(body.stateTransition).to)) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_STATE_TRANSITION' });
  if (body.schemaVersion !== 1 || body.kind !== 'managed-terminal' || body.runId !== state.runId || body.slotId !== state.slotId
    || body.sourceSha !== state.source.sha || body.configSha256 !== state.source.configSha256 || !validRetirementHost(body.host)
    || !state.host || body.host.hostId !== state.host.hostId || body.host.platform !== state.host.platform
    || typeof proofSha256 !== 'string' || proofDigest(body as TerminalBody) !== proofSha256) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_BINDING' });
  const terminal = value as ManagedTerminal, last = state.processes.at(-1);
  // 前一命令已归并的回执不能证明后来意图已停止；保留该意图供恢复层明确报告 unknown。
  if (last && command.id !== last.id && !last.terminalSha256
    && state.processes.some(previous => previous.id === command.id && previous.terminalSha256 === proofSha256)) return { state };
  if (!last || command.id !== last.id || command.name !== last.name || state.processes.filter(item => item.id === command.id).length !== 1
    || !matchesObservationBinding(last, terminal.command)
    || (last.terminalSha256 !== undefined && last.terminalSha256 !== proofSha256)
    || (last.scope !== undefined && JSON.stringify(last.scope) !== JSON.stringify(command.scope))
    || (last.identity !== undefined && JSON.stringify(last.identity) !== JSON.stringify(command.identity))
    || JSON.stringify(last.descendants) !== JSON.stringify(command.descendants)) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_COMMAND_BINDING' });
  const assertFiles = async () => {
    await assertMetadataPaths(paths); await assertMetadataFile(paths.ownershipPath, terminal.files.owner);
    await assertMetadataFile(paths.anchorPath, terminal.files.anchor);
    const current = await inspectMetadataFile(paths.statePath);
    if (!sameMetadataFile(current, terminal.files.state) && !(terminal.stateTransition && sameMetadataFile(current, terminal.stateTransition.to))) {
      throw new ReleaseError('SLOT_STATE', { reason: 'METADATA_REPLACED' });
    }
    if (!options.allowReleasedLock || await pathExists(paths.lockPath)) await assertMetadataFile(paths.lockPath, terminal.files.lock);
    await assertMetadataFile(path, original);
  };
  await assertFiles();
  if (JSON.stringify(await readBoundedJson(paths.statePath)) !== JSON.stringify(state)) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_STATE_BINDING' });
  const host = await readRetirementHost(options.signal);
  if (host.hostId !== terminal.host.hostId || host.platform !== terminal.host.platform) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_HOST_CHANGED' });
  const merged = { ...state, processes: [...state.processes.slice(0, -1), { ...terminal.command, terminalSha256: proofSha256 }] };
  parseManagedState(merged, state.source, state.slotId);
  const restored = merged.processes.at(-1);
  if (!restored || !hasVerifiedManagedStop(restored)) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'TERMINAL_STOP_UNPROVEN' });
  await assertFiles();
  return { state: merged, terminal };
}
export async function createTerminalWriter(slot: ManagedSlot, state: ManagedState, command: ManagedCommand): Promise<TerminalWriter> {
  const { paths } = slot, path = resolve(paths.slotRoot, 'terminal.json');
  // 放行前为固定大小的宿主、文件及 scope 绑定留足余量；实际写入仍独立检查硬上限。
  if (Buffer.byteLength(JSON.stringify(command)) + 4096 > terminalLimit) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'TERMINAL_LIMIT' });
  if (!state.host || state.source.config.source.mode !== 'managed-commit') throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_HOST_REQUIRED' });
  const host = state.host, minFreeBytes = state.source.config.source.minFreeBytes;
  const files = { owner: await inspectMetadataFile(paths.ownershipPath), anchor: await inspectMetadataFile(paths.anchorPath),
    lock: await inspectMetadataFile(paths.lockPath), state: await inspectMetadataFile(paths.statePath) };
  let terminalFile = await inspectMetadataFile(path, terminalLimit);
  let saved: ManagedTerminal | undefined;
  let prepared: MetadataFile | undefined;
  const assertOwned = async () => {
    await assertMetadataPaths(paths); await slot.assertMetadataOwned();
    await assertMetadataFile(paths.ownershipPath, files.owner); await assertMetadataFile(paths.anchorPath, files.anchor);
    await assertMetadataFile(paths.lockPath, files.lock); await assertMetadataFile(paths.statePath, files.state); await assertMetadataFile(path, terminalFile);
  };
  await assertOwned();
  return { assertOwned, prepareState: async next => {
    await assertOwned();
    if (saved) {
      const updated = sealTerminal({ schemaVersion: saved.schemaVersion, kind: saved.kind, runId: saved.runId, slotId: saved.slotId,
        sourceSha: saved.sourceSha, configSha256: saved.configSha256, host: saved.host, command: saved.command, files: { ...files }, stateTransition: { to: next } });
      await writeReservedMetadata(path, updated, paths, minFreeBytes, assertOwned);
      terminalFile = await inspectMetadataFile(path, terminalLimit); await assertOwned(); saved = updated;
    }
    prepared = next;
  }, acceptState: async current => {
    if (!prepared || prepared.sha256 !== metadataDigest(`${JSON.stringify(current)}\n`)) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_STATE_CHANGED' });
    await assertMetadataFile(paths.statePath, prepared);
    files.state = prepared; prepared = undefined;
    // 写前封印同时覆盖前后两个身份；rename 后只更新内存，不再产生第二次持久化窗口。
    await assertOwned();
  }, write: async command => {
    await assertOwned();
    const currentHost = await readRetirementHost();
    if (currentHost.hostId !== host.hostId || currentHost.platform !== host.platform) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_HOST_CHANGED' });
    const batch = command.kind === 'checkout-observation';
    if (batch ? !hasObservationStopWitness(command) || command.observations?.some(item => item.scope?.binding.startsWith(`${state.runId}:${item.id}:`) !== true)
      : !hasVerifiedManagedStop(command) || command.scope?.binding.startsWith(`${state.runId}:${command.id}:`) !== true) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'TERMINAL_STOP_UNPROVEN' });
    const copy = structuredClone(command); delete copy.terminalSha256;
    const body = { schemaVersion: 1 as const, kind: 'managed-terminal' as const, runId: state.runId, slotId: state.slotId,
      sourceSha: state.source.sha, configSha256: state.source.configSha256, host, files: { ...files }, command: copy };
    const sealed = sealTerminal(body);
    await writeReservedMetadata(path, sealed, paths, minFreeBytes, assertOwned);
    terminalFile = await inspectMetadataFile(path, terminalLimit);
    await assertOwned();
    saved = sealed;
    return sealed.proofSha256;
  } };
}
