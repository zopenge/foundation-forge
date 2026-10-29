import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import { commandErrorCodes, type CommandObserver, type CommandResult, type CommandRunner, type CommandSpec, type RunningCommand } from '@openge/forge-command-runner';
import { processControlErrorCodes } from '@openge/forge-process-control';
import type { ExecutionLifecycle, ManagedCommand, ManagedSession, ManagedSlot, ManagedState } from './release-context.js';
import type { ReleaseStep } from '../contracts.js';
import { record, ReleaseError } from './errors.js';
import { within } from './managed-io.js';
import { assertManagedPaths } from './managed-paths.js';
import { BudgetMonitor } from './managed-budget.js';
import { foregroundGitArguments } from './execution.js';
import { createManagedExecution } from './managed-execution.js';
import { assertNoGitContext, isolatedGitEnvironment } from './git-context.js';
import { hasObservationStopWitness, hasVerifiedManagedClosure, hasVerifiedManagedStop } from './managed-closure.js';
import { checkoutObservationPlan } from './managed-observation.js';
import { readRetirementHost } from './retirement-host.js';
import { createTerminalWriter, restoreManagedTerminal, type TerminalWriter } from './managed-terminal.js';
import { metadataReserveBytes } from './managed-metadata.js';
import { assertManagedHistory, captureManagedHistory } from './managed-history.js';

const knownCauseCodes = new Set<string>([...getSystemErrorMap().values()].map(([code]) => code)
  .concat(Object.values(commandErrorCodes), Object.values(processControlErrorCodes)));
function lifecycleError(error: unknown, reason: string, step: string, phase?: string): ReleaseError {
  if (error instanceof ReleaseError) return error;
  const value = record(error), code = value.code;
  const known = typeof code === 'string' && knownCauseCodes.has(code);
  // 只保留固定操作名和元数据文件名，帮助定位失败边界，不暴露消息、完整路径或参数。
  const syscall = typeof value.syscall === 'string' && ['open', 'read', 'write', 'rename', 'unlink', 'lstat', 'stat', 'statfs', 'mkdir', 'scandir'].includes(value.syscall) ? value.syscall : undefined;
  const file = typeof value.path === 'string' ? basename(value.path) : undefined;
  return new ReleaseError('PROCESS_STATE_UNKNOWN', { reason, step,
    ...(known ? { causeCode: code, ...(phase ? { causePhase: phase } : {}), ...(syscall ? { causeSyscall: syscall } : {}),
      ...(file && ['state.json', '.state.json.next', 'terminal.json', '.terminal.json.next'].includes(file) ? { causeFile: file } : {}) } : {}) });
}
class ManagedProcess implements ExecutionLifecycle {
  private tail = Promise.resolve();
  private terminal: TerminalWriter | undefined;
  private observation: { command: ManagedCommand; executing: boolean; closing: boolean } | undefined;
  private startingObservation = false;
  constructor(readonly slot: ManagedSlot, readonly state: ManagedState, readonly budget: BudgetMonitor) {}
  async persist(): Promise<void> {
    await this.terminal?.assertOwned();
    await this.slot.store.writeState(this.state, async prepared => { await this.terminal?.prepareState(prepared); });
    await this.terminal?.acceptState(this.state);
  }
  async guard(): Promise<void> { assertNoGitContext(); await assertManagedPaths(this.slot.paths); await this.slot.lock.assertOwned(); await assertManagedHistory(this.slot.paths, this.state); }
  async assertClosed(): Promise<void> {
    if (!this.state.processes.every(hasVerifiedManagedClosure)) throw new ReleaseError('PROCESS_STATE_UNKNOWN');
  }
  async assertStopped(): Promise<void> {
    if (!this.state.processes.every(hasVerifiedManagedStop)) throw new ReleaseError('PROCESS_STATE_UNKNOWN');
    await this.guard(); await this.terminal?.assertOwned();
    const disk = await this.slot.store.read();
    if (!disk || disk.runId !== this.state.runId) throw new ReleaseError('SLOT_STATE', { reason: 'RUN_CHANGED' });
    const restored = await restoreManagedTerminal(this.slot.paths, disk);
    if (!restored.state.processes.every(hasVerifiedManagedStop)) throw new ReleaseError('PROCESS_STATE_UNKNOWN');
  }
  async observeCheckout<T>(operation: () => Promise<T>): Promise<T> {
    if (this.observation || this.startingObservation) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_NESTED' });
    this.startingObservation = true;
    const command: ManagedCommand = { id: randomUUID(), name: 'checkout-frozen', kind: 'checkout-observation',
      plan: checkoutObservationPlan(this.slot.source), observations: [], status: 'intent', descendants: [], observationComplete: false };
    let terminal: TerminalWriter;
    try {
      await this.guard(); await this.assertClosed();
      terminal = await createTerminalWriter(this.slot, this.state, command); this.terminal = terminal;
      this.state.processes.push(command); await this.persist();
      this.observation = { command, executing: false, closing: false };
    } finally { this.startingObservation = false; }
    let value: T | undefined, failed = false, failure: unknown;
    try {
      value = await operation();
      if (command.observations?.length !== command.plan?.length) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_INCOMPLETE' });
    } catch (error) { failed = true; failure = error; }
    this.observation.closing = true;
    try { try {
      const observations = command.observations ?? [];
      command.status = observations.every(hasVerifiedManagedClosure) ? 'closed' : 'stopped';
      command.observationComplete = true;
      if (this.observation.executing || !hasObservationStopWitness(command)) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_STOP_UNPROVEN' });
      // 每条查询已独立核验；提交前仍重新观察路径、锁、历史、预算及元数据身份。
      await this.guard(); await this.budget.sample(); await terminal.assertOwned();
      command.terminalSha256 = await terminal.write(command);
      await this.persist();
    } catch (error) {
      if (!command.terminalSha256) {
        command.status = 'unknown'; command.observationComplete = false;
        try { await this.persist(); } catch { /* 耐久意图保留 UNKNOWN，不用内存停止事实解锁。 */ }
      }
      if (!failed) throw lifecycleError(error, 'OBSERVATION_COMMIT_FAILED', command.name);
      // 原解析、权限或取消错误优先；无批次证明时状态仍然未知。
    }
    if (failed) throw failure;
    return value as T;
    } finally { this.observation = undefined; }
  }
  async execute(runner: CommandRunner, name: string, spec: CommandSpec, observer?: CommandObserver): Promise<CommandResult> {
    const batch = this.observation;
    if (this.startingObservation) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_NESTED' });
    await this.guard();
    if (batch) {
      await this.terminal?.assertOwned();
      const observations = batch.command.observations ?? [], expected = batch.command.plan?.[observations.length];
      if (this.observation !== batch || batch.closing || batch.executing || this.state.processes.at(-1) !== batch.command || !this.state.processes.slice(0, -1).every(hasVerifiedManagedClosure)
        || !observations.every(item => hasVerifiedManagedClosure(item) && item.closure?.exitCode === 0)
        || !expected || spec.command !== 'git' || name !== expected.name || spec.cwd !== this.slot.paths.checkoutRoot
        || JSON.stringify(spec.args) !== JSON.stringify([...foregroundGitArguments, ...expected.args])) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_PLAN' });
      // 此后到占用/追加之间没有 await，迟到调用不能进入已经封印的批次。
      batch.executing = true;
    } else await this.assertClosed();
    const command: ManagedCommand = { id: randomUUID(), name, status: 'intent', descendants: [], observationComplete: false };
    const binding = `${this.state.runId}:${command.id}:${randomUUID()}`;
    const terminal = batch ? this.terminal : await createTerminalWriter(this.slot, this.state, command);
    if (!terminal) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_TERMINAL' });
    if (batch) batch.command.observations?.push(command);
    else { this.terminal = terminal; this.state.processes.push(command); await this.persist(); }
    try { return await this.budget.run(async signal => {
      const failed = new AbortController(), combined = AbortSignal.any([signal, failed.signal]);
      let failure: unknown, running: RunningCommand | undefined;
      let phase: 'command' | 'terminal' | 'closed-state' = 'command';
      let requestedTermination: 'abort' | 'timeout' | undefined;
      const enqueue = (operation: () => Promise<void>) => {
        this.tail = this.tail.then(operation).catch((error: unknown) => { failure ??= error; command.observationComplete = false; failed.abort(); });
      };
      try {
        const environment = spec.environment ?? { mode: 'inherit' as const };
        running = runner.start({ ...spec, signal: combined, ownedScope: { start: 'manual', binding },
          environment: { ...environment, values: { ...environment.values, ...isolatedGitEnvironment(), FORGE_RELEASE_COMMAND: this.state.command, FORGE_RELEASE_SHA: this.slot.source.sha } } }, event => {
          observer?.(event);
          if (event.type === 'termination-requested' && (event.reason === 'abort' || event.reason === 'timeout')) requestedTermination = event.reason;
          if (event.type === 'spawned') enqueue(async () => { command.pid = event.pid; command.status = 'spawned'; if (!batch) await this.persist(); });
          if (event.type === 'scope-ready') enqueue(async () => {
            if (event.binding !== binding || !running?.authorizeStart || combined.aborted) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'SCOPE_BINDING' });
            command.identity = { pid: event.identity.pid, startToken: event.identity.startToken };
            command.scope = { scopeId: event.scopeId, binding }; command.status = 'identified';
            await this.guard(); await this.budget.sample();
            if (batch) await terminal?.assertOwned(); else await this.persist();
            // 写入、预算和所有权任一步失败都不放行真实 argv。
            await this.guard(); if (combined.aborted) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'START_CANCELLED' });
            await running.authorizeStart();
          });
        });
        const result = await running.result; await this.tail;
        command.observationComplete = !!result.ownedScope;
        command.closure = { observedAt: new Date().toISOString(), exitCode: result.exitCode, termination: result.terminationReason,
          ...(requestedTermination ? { requestedTermination } : {}),
          ...(result.ownedScope ? { ownedScope: result.ownedScope } : {}) };
        command.status = result.terminationReason === 'exit' && command.observationComplete ? 'closed' : 'unknown';
        if (!hasVerifiedManagedClosure(command) && requestedTermination
          && !result.diagnostics.some(item => ['COMMAND_SCOPE_FAILED', 'COMMAND_TERMINATION_FAILED', 'COMMAND_OBSERVER_FAILED'].includes(item.code))) command.status = 'stopped';
        if (!hasVerifiedManagedStop(command)) { command.status = 'unknown'; command.observationComplete = false; }
        phase = 'terminal';
        if (!batch && hasVerifiedManagedStop(command)) command.terminalSha256 = await terminal.write(command);
        if (failure !== undefined) throw lifecycleError(failure, 'JOURNAL_FAILED', name);
        phase = 'closed-state';
        if (!batch) await this.persist();
        if (!hasVerifiedManagedStop(command)) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'CLOSURE_UNPROVEN', commandId: command.id, step: name,
          termination: result.terminationReason, exitCode: result.exitCode, identified: !!command.identity,
          ...(result.ownedScope ? { scopeReason: result.ownedScope.reason, empty: result.ownedScope.empty } : {}),
          diagnostics: result.diagnostics.map(item => ({ code: item.code, stage: item.details.stage })) });
        // runner 的原始分类保存在回执；已验证受控停止时，执行结果仍保留取消/超时的原意。
        return command.status === 'stopped' && requestedTermination ? { ...result, terminationReason: requestedTermination } : result;
      } catch (error) {
        failed.abort(); await running?.terminate(); await this.tail;
        if (batch ? !hasVerifiedManagedStop(command) : !command.terminalSha256) { command.status = 'unknown'; command.observationComplete = false; }
        if (!batch) try { await this.persist(); } catch { /* 最后已持久化的意图仍不是关闭证明，不能释放槽。 */ }
        throw lifecycleError(error, 'PROCESS_LIFECYCLE_FAILED', name, phase);
      }
    }, spec.signal); } finally { if (batch) batch.executing = false; }
  }
}
export async function createManagedSession(slot: ManagedSlot, command: 'check' | 'publish' | 'verify', signal?: AbortSignal): Promise<ManagedSession> {
  if (slot.source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const state: ManagedState = { schemaVersion: 3, slotId: slot.slotId, runId: slot.runId, source: slot.source, command,
    coordinator: slot.coordinator, host: await readRetirementHost(signal), history: await captureManagedHistory(slot.paths), stage: 'admission', status: 'running', processes: [], effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } };
  const budget = new BudgetMonitor(slot.paths, slot.source.config.source, undefined, metadataReserveBytes), lifecycle = new ManagedProcess(slot, state, budget), steps: ReleaseStep[] = [];
  await lifecycle.persist();
  return { slot, command, state, budget, steps, execution: createManagedExecution(slot.paths.checkoutRoot, slot.source.config, signal, steps, lifecycle),
    persist: () => lifecycle.persist(), assertClosed: () => lifecycle.assertClosed(), assertStopped: () => lifecycle.assertStopped(),
    executionAt: cwd => { if (!within(slot.paths.slotRoot, resolve(cwd))) throw new ReleaseError('SLOT_PATH'); return createManagedExecution(cwd, slot.source.config, signal, steps, lifecycle); } };
}
