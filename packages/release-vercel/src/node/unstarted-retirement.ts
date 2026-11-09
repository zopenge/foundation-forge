import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { validateReleaseConfig } from './config.js';
import { record } from './errors.js';
import { parseManagedReceipt, parseManagedState } from './managed-state.js';
import { validRetirementHost } from './retirement-host.js';
import type { FrozenSource } from './release-context.js';
import type { RetirementSnapshot } from './retirement-record.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const timestamp = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));
const noEffects = (value: unknown): boolean => {
  const effects = record(value);
  return effects.developmentPush === 'not-attempted' && effects.releasePush === 'not-attempted'
    && Object.entries(effects).every(([key, effect]) => ['developmentPush', 'releasePush', 'deploymentCreate', 'deploymentPromote', 'versionAliasAssign'].includes(key)
      && effect === 'not-attempted');
};

/** 仅判断完整原始快照是否符合显式放弃协议；不将unknown改成正常关闭，也不补写历史事实。 */
export function isUnstartedRetirementSnapshot(snapshot: RetirementSnapshot): boolean {
  try {
    const raw = record(JSON.parse(snapshot.state) as unknown), input = record(raw.source);
    if (typeof input.root !== 'string' || !isAbsolute(input.root) || resolve(input.root) !== input.root
      || typeof input.configPath !== 'string' || typeof input.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(input.sha)
      || typeof input.configBlobOid !== 'string' || !/^[a-f0-9]{40}$/u.test(input.configBlobOid)
      || typeof input.configSha256 !== 'string' || typeof input.fetchUrl !== 'string'
      || typeof raw.slotId !== 'string' || !uuid.test(raw.slotId)) return false;
    const config = validateReleaseConfig(input.config);
    if (config.source.mode !== 'managed-commit'
      || createHash('sha256').update(JSON.stringify(input.config)).digest('hex') !== input.configSha256) return false;
    const source: FrozenSource = { root: input.root, configPath: input.configPath, sha: input.sha, configBlobOid: input.configBlobOid,
      configSha256: input.configSha256, fetchUrl: input.fetchUrl, config };
    const state = parseManagedState(raw, source, raw.slotId), command = state.processes[0];
    if (state.schemaVersion !== 3 || !uuid.test(state.runId) || !['check', 'publish'].includes(state.command)
      || state.stage !== 'checkout' || state.status !== 'unknown' || !validRetirementHost(state.host) || state.host.platform !== 'win32'
      || state.coordinator.pid <= 0 || !state.coordinator.startToken || state.processes.length !== 1 || !command
      || !uuid.test(command.id) || command.name !== 'git' || command.status !== 'unknown' || command.observationComplete !== false
      || command.descendants.length !== 0 || ['pid', 'identity', 'scope', 'kind', 'plan', 'observations', 'notStarted', 'terminalSha256']
        .some(key => record(command)[key] !== undefined)
      || ['pendingPush', 'prebuilt', 'prebuiltResolutions', 'completion', 'completionInput'].some(key => raw[key] !== undefined)
      || !noEffects(state.effects)) return false;
    const closure = command.closure, owned = closure?.ownedScope;
    if (!closure || !owned || closure.termination !== 'termination-failure' || closure.exitCode !== null
      || closure.requestedTermination !== 'abort' || !timestamp(closure.observedAt) || !timestamp(owned.observedAt)
      || owned.status !== 'unknown' || owned.reason !== 'provider-failed' || owned.empty !== true || owned.rootIdentity !== undefined
      || !uuid.test(owned.scopeId) || !owned.binding.startsWith(`${state.runId}:${command.id}:`)
      || !uuid.test(owned.binding.slice(state.runId.length + command.id.length + 2))) return false;
    const lock = record(JSON.parse(snapshot.lock) as unknown), owner = record(JSON.parse(snapshot.owner) as unknown);
    const anchor = record(JSON.parse(snapshot.anchor) as unknown), slotRoot = resolve(source.root, config.source.slotPath);
    if (lock.runId !== state.runId || lock.pid !== state.coordinator.pid || !same(lock.identity, state.coordinator)
      || typeof lock.token !== 'string' || !uuid.test(lock.token) || owner.schemaVersion !== 2 || anchor.schemaVersion !== 2
      || owner.slotId !== state.slotId || anchor.slotId !== state.slotId || owner.sourceRoot !== source.root || anchor.sourceRoot !== source.root
      || owner.configPath !== source.configPath || anchor.configPath !== source.configPath || owner.repository !== config.git.repository
      || anchor.slotPath !== slotRoot) return false;
    if (state.command === 'publish') {
      const latest = record(anchor.latestPublish);
      if (latest.runId !== state.runId || latest.sha !== source.sha || latest.configSha256 !== source.configSha256) return false;
    }
    const text = state.command === 'publish' ? snapshot.publish : snapshot.check;
    if (text === null) return false;
    const receipt = parseManagedReceipt(JSON.parse(text) as unknown, source, state.slotId), report = receipt.report;
    if (!same(receipt.source, raw.source) || report.runId !== state.runId || report.slotId !== state.slotId || report.command !== state.command
      || report.ok !== false || report.stage !== 'checkout' || report.sourceRoot !== source.root || report.configPath !== source.configPath
      || report.executionRoot !== resolve(slotRoot, 'checkout') || report.candidateSha !== source.sha || report.configSha256 !== source.configSha256
      || !timestamp(report.startedAt) || !timestamp(report.finishedAt) || report.steps.length !== 0
      || report.processes?.status !== 'unknown' || report.processes.knownCount !== 0 || !noEffects(report.effects) || !same(report.effects, state.effects)
      || report.deployment !== undefined || report.prebuilt !== undefined || report.completion !== undefined || report.candidateContext !== undefined
      || report.error?.code !== 'PROCESS_STATE_UNKNOWN') return false;
    const details = report.error.details, diagnostics = details.diagnostics;
    return details.reason === 'CLOSURE_UNPROVEN' && details.commandId === command.id && details.step === command.name
      && details.identified === false && details.termination === closure.termination && details.exitCode === closure.exitCode
      && details.scopeReason === owned.reason && details.empty === true && Array.isArray(diagnostics) && diagnostics.length === 2
      && diagnostics.some(value => record(value).code === 'COMMAND_SCOPE_FAILED' && record(value).stage === 'provider')
      && diagnostics.some(value => record(value).code === 'COMMAND_SCOPE_UNKNOWN');
  } catch { return false; }
}
