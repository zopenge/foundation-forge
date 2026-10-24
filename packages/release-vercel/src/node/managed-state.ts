import type { ReleaseReport } from '../contracts.js';
import type { FrozenSource, ManagedAnchor, ManagedPaths, ManagedReceipt, ManagedState, ManagedStateStore } from './release-context.js';
import { record, ReleaseError } from './errors.js';
import { atomicJson, readBoundedJson } from './managed-io.js';
import { validateReleaseConfig } from './config.js';
import { resolve } from 'node:path';
import { hasVerifiedManagedClosure, hasVerifiedManagedStop } from './managed-closure.js';
import type { ManagedCommand } from './release-context.js';
import { validRetirementHost } from './retirement-host.js';
import { metadataReserveBytes } from './managed-metadata.js';

const uuid = /^[a-f0-9-]{36}$/u, sha = /^[a-f0-9]{40}$/u;
function boundSource(value: unknown, source: FrozenSource): asserts value is FrozenSource {
  const item = record(value);
  if (item.root !== source.root || item.configPath !== source.configPath || typeof item.sha !== 'string' || !sha.test(item.sha)
    || typeof item.configBlobOid !== 'string' || !sha.test(item.configBlobOid) || typeof item.configSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.configSha256)
    || typeof item.fetchUrl !== 'string') throw new ReleaseError('SLOT_STATE', { reason: 'SOURCE_IDENTITY' });
  validateReleaseConfig(item.config);
}
export function parseManagedReceipt(value: unknown, source: FrozenSource, slotId: string): ManagedReceipt {
  const item = record(value), report = record(item.report);
  if (item.schemaVersion !== 2 || item.slotId !== slotId || report.schemaVersion !== 2 || typeof report.ok !== 'boolean'
    || !['publish', 'check', 'verify'].includes(String(report.command)) || !Array.isArray(report.steps)
    || typeof report.startedAt !== 'string' || typeof report.finishedAt !== 'string') throw new ReleaseError('SLOT_STATE', { reason: 'RECEIPT' });
  boundSource(item.source, source);
  if (report.candidateSha !== item.source.sha || report.configSha256 !== item.source.configSha256) throw new ReleaseError('SLOT_STATE', { reason: 'RECEIPT_IDENTITY' });
  validateEffects(report.effects);
  return value as ManagedReceipt;
}
function validateEffects(value: unknown): void {
  const item = record(value);
  if (![item.developmentPush, item.releasePush].every(effect => ['not-attempted', 'pushed', 'already-current', 'unknown', 'not-current'].includes(String(effect)))) throw new ReleaseError('SLOT_STATE', { reason: 'EFFECTS' });
}
export function parseManagedState(value: unknown, source: FrozenSource, slotId: string): ManagedState {
  const item = record(value), owner = record(item.coordinator);
  if ((item.schemaVersion !== 2 && item.schemaVersion !== 3) || item.slotId !== slotId || typeof item.runId !== 'string' || !uuid.test(item.runId)
    || !['check', 'publish', 'verify'].includes(String(item.command)) || !['running', 'closed', 'unknown'].includes(String(item.status))
    || !Number.isSafeInteger(owner.pid) || typeof owner.startToken !== 'string' || !Array.isArray(item.processes)) throw new ReleaseError('SLOT_STATE', { reason: 'STATE' });
  boundSource(item.source, source); validateEffects(item.effects);
  if (item.host !== undefined && !validRetirementHost(item.host)) throw new ReleaseError('SLOT_STATE', { reason: 'HOST_OBSERVATION' });
  if (item.schemaVersion === 3) {
    if (!Array.isArray(item.history) || item.history.length > 10_000) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_BINDING_MISSING' });
    const paths = new Set<string>();
    for (const value of item.history) {
      const entry = record(value), file = record(entry.file), identity = record(file.identity);
      if (typeof entry.path !== 'string' || !/^(history|retired)\/[a-f0-9-]{36}\.json$/u.test(entry.path) || paths.has(entry.path)
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || ![identity.dev, identity.ino].every(part => typeof part === 'string' && /^\d+$/u.test(part))) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_BINDING' });
      paths.add(entry.path);
    }
  }
  for (const value of item.processes) {
    const command = record(value);
    if (typeof command.id !== 'string' || typeof command.name !== 'string' || !['intent', 'spawned', 'identified', 'closed', 'stopped', 'unknown'].includes(String(command.status))
      || typeof command.observationComplete !== 'boolean' || !Array.isArray(command.descendants)) throw new ReleaseError('SLOT_STATE', { reason: 'PROCESS' });
    for (const value of [command.identity, ...command.descendants].filter(value => value !== undefined)) {
      const identity = record(value);
      if (!Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || typeof identity.startToken !== 'string' || identity.startToken === '') throw new ReleaseError('SLOT_STATE', { reason: 'PROCESS_IDENTITY' });
    }
    if (command.scope !== undefined) {
      const scope = record(command.scope), prefix = `${String(item.runId)}:${command.id}:`;
      if (typeof scope.scopeId !== 'string' || !uuid.test(scope.scopeId) || typeof scope.binding !== 'string' || !scope.binding.startsWith(prefix) || !uuid.test(scope.binding.slice(prefix.length))) throw new ReleaseError('SLOT_STATE', { reason: 'SCOPE_BINDING' });
    }
    const witness = record(command.closure), owned = witness.ownedScope === undefined ? undefined : record(witness.ownedScope);
    if (command.terminalSha256 !== undefined && (typeof command.terminalSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(command.terminalSha256))) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_DIGEST' });
    if (owned) {
      const root = record(owned.rootIdentity);
      if (typeof owned.scopeId !== 'string' || !uuid.test(owned.scopeId) || typeof owned.binding !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(owned.binding)
        || typeof owned.observedAt !== 'string' || !Number.isFinite(Date.parse(owned.observedAt)) || !['closed', 'unknown'].includes(String(owned.status))
        || (owned.empty !== undefined && typeof owned.empty !== 'boolean')
        || (owned.rootIdentity !== undefined && (!Number.isSafeInteger(root.pid) || Number(root.pid) <= 0 || typeof root.startToken !== 'string' || root.startToken === ''))
        || (owned.status === 'closed' ? owned.reason !== 'normal' || owned.empty !== true || !owned.rootIdentity : !['terminated', 'descendants-remained', 'provider-failed', 'owner-lost'].includes(String(owned.reason)))) throw new ReleaseError('SLOT_STATE', { reason: 'SCOPE_WITNESS' });
    }
    if (command.status === 'closed') {
      const closure = record(command.closure);
      if (!command.identity || command.observationComplete !== true || closure.termination !== 'exit' || typeof closure.observedAt !== 'string'
        || !Number.isFinite(Date.parse(closure.observedAt)) || (closure.exitCode !== null && !Number.isSafeInteger(closure.exitCode))) throw new ReleaseError('SLOT_STATE', { reason: 'CLOSURE_WITNESS' });
      if ((command.scope !== undefined || owned !== undefined) && !hasVerifiedManagedClosure(value as ManagedCommand)) throw new ReleaseError('SLOT_STATE', { reason: 'SCOPE_CLOSURE_BINDING' });
    }
    if (command.status === 'stopped' && (!command.terminalSha256 || !hasVerifiedManagedStop(value as ManagedCommand))) throw new ReleaseError('SLOT_STATE', { reason: 'STOP_WITNESS' });
  }
  return value as ManagedState;
}
function clip(value: string): string {
  let bytes = Buffer.from(value);
  if (bytes.length <= 2048) return value;
  bytes = bytes.subarray(0, 2048);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = bytes.length; end >= bytes.length - 3; end--) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* 只去掉不完整的末尾编码单元。 */ }
  }
  throw new ReleaseError('SLOT_STATE');
}
export function summarizeReport(report: ReleaseReport): ReleaseReport {
  return { ...report, steps: report.steps.map(step => ({ ...step,
    ...(step.stdout === undefined ? {} : { stdout: clip(step.stdout) }), ...(step.stderr === undefined ? {} : { stderr: clip(step.stderr) }),
    ...((step.stdout !== undefined && Buffer.byteLength(step.stdout) > 2048) || (step.stderr !== undefined && Buffer.byteLength(step.stderr) > 2048) ? { truncated: true } : {}) })) };
}
export function createManagedStateStore(paths: ManagedPaths, source: FrozenSource, slotId: string, guard: () => Promise<void>): ManagedStateStore {
  if (source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const config = source.config.source;
  const write = (path: string, value: unknown, limit = 1_048_576) => atomicJson(path, value, limit, paths, guard, config.maxBytes - metadataReserveBytes, config.minFreeBytes + metadataReserveBytes);
  const receiptPath = (kind: 'check' | 'publish') => resolve(paths.slotRoot, `latest-${kind}.json`);
  return {
    read: async () => { await guard(); const value = await readBoundedJson(paths.statePath); return value === undefined ? undefined : parseManagedState(value, source, slotId); },
    writeState: async (state, beforeCommit) => { parseManagedState(state, source, slotId);
      await atomicJson(paths.statePath, state, 1_048_576, paths, guard, config.maxBytes - metadataReserveBytes, config.minFreeBytes + metadataReserveBytes, beforeCommit); },
    readReceipt: async kind => { await guard(); const value = await readBoundedJson(receiptPath(kind)); return value === undefined ? undefined : parseManagedReceipt(value, source, slotId); },
    writeReceipt: async (kind, receipt) => { parseManagedReceipt(receipt, source, slotId); await write(receiptPath(kind), { ...receipt, report: summarizeReport(receipt.report) }); },
    writeAnchor: async (anchor: ManagedAnchor) => { if (anchor.slotId !== slotId || anchor.sourceRoot !== source.root || anchor.configPath !== source.configPath) throw new ReleaseError('SLOT_STATE'); await write(paths.anchorPath, anchor, 65_536); },
  };
}
