import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { record } from './errors.js';
import { hasVerifiedManagedStop } from './managed-closure.js';
import { managedCommandIdentities } from './managed-observation.js';
import { parseManagedReceipt } from './managed-state.js';
import type { ManagedState } from './managed-state-contracts.js';
import type { RetirementSnapshot } from './retirement-contracts.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

/** 旧 SDK 保留 unknown；这里只从匹配的原失败收据和 Job 空集合见证识别可观察的最后一条检查。 */
export function isDrainedRetirementSnapshot(state: ManagedState, snapshot: RetirementSnapshot): boolean {
  const { source } = state, command = state.processes.at(-1);
  if (state.host.platform !== 'win32' || !['check', 'publish'].includes(state.command) || state.stage !== 'checks' || state.status !== 'unknown'
    || source.config.source.mode !== 'managed-commit' || state.pendingPush || state.prebuilt || state.prebuiltResolutions || state.completion || state.completionInput
    || Object.values(state.effects).some(effect => effect !== 'not-attempted') || !command
    || command.kind !== undefined || command.status !== 'unknown' || command.observationComplete || command.notStarted || command.terminalSha256
    || !uuid.test(state.runId) || !uuid.test(command.id) || !state.processes.slice(0, -1).every(hasVerifiedManagedStop)
    || state.processes.some(item => item !== command && item.id === command.id)) return false;
  const index = /^check:(0|[1-9]\d*)$/u.exec(command.name)?.[1];
  if (index === undefined || !source.config.checks[Number(index)]) return false;
  const { closure, identity, scope } = command, owned = closure?.ownedScope;
  const prefix = `${state.runId}:${command.id}:`;
  if (!identity || command.pid !== identity.pid || !scope || !uuid.test(scope.scopeId) || !scope.binding.startsWith(prefix)
    || !uuid.test(scope.binding.slice(prefix.length)) || !closure || closure.requestedTermination !== undefined
    || closure.termination !== 'termination-failure' || !Number.isSafeInteger(closure.exitCode) || !Number.isFinite(Date.parse(closure.observedAt))
    || owned?.status !== 'unknown' || owned.reason !== 'descendants-remained' || owned.empty !== true
    || owned.scopeId !== scope.scopeId || owned.binding !== scope.binding || !Number.isFinite(Date.parse(owned.observedAt))
    || !isDeepStrictEqual(owned.rootIdentity, identity)) return false;
  const text = state.command === 'publish' ? snapshot.publish : snapshot.check;
  if (text === null) return false;
  try {
    const receipt = parseManagedReceipt(JSON.parse(text) as unknown, source, state.slotId), report = receipt.report;
    const slot = resolve(source.root, source.config.source.slotPath);
    const anchor = record(JSON.parse(snapshot.anchor) as unknown), latest = record(anchor.latestPublish);
    if (anchor.slotId !== state.slotId || anchor.sourceRoot !== source.root || anchor.configPath !== source.configPath || anchor.slotPath !== slot
      || (state.command === 'publish' && (latest.runId !== state.runId || latest.sha !== source.sha || latest.configSha256 !== source.configSha256))) return false;
    const knownCount = new Set(state.processes.flatMap(managedCommandIdentities).map(item => `${item.pid}:${item.startToken}`)).size;
    if (!isDeepStrictEqual(receipt.source, source) || report.command !== state.command || report.runId !== state.runId || report.slotId !== state.slotId
      || report.ok || report.stage !== state.stage || report.sourceRoot !== source.root || report.executionRoot !== resolve(slot, 'checkout')
      || report.configPath !== source.configPath || report.processes?.status !== 'unknown' || report.processes.knownCount !== knownCount
      || report.prebuilt || report.deployment || report.completion || !isDeepStrictEqual(report.effects, state.effects)
      || report.error?.code !== 'PROCESS_STATE_UNKNOWN') return false;
    const detail = report.error.details, diagnostics = detail.diagnostics;
    return detail.reason === 'CLOSURE_UNPROVEN' && detail.commandId === command.id && detail.step === command.name
      && detail.identified === true && detail.termination === closure.termination && detail.exitCode === closure.exitCode
      && detail.scopeReason === owned.reason && detail.empty === true && Array.isArray(diagnostics)
      && diagnostics.length === 1 && record(diagnostics[0]).code === 'COMMAND_SCOPE_UNKNOWN';
  } catch { return false; }
}
