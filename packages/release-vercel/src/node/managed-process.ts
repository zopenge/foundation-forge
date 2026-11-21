import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { CommandObserver, CommandRunner, CommandSpec, RunningCommand } from '@openge/forge-command-runner';
import type { ExecutionLifecycle, ExecutionResult } from './execution-lifecycle.js';
import type { ManagedCommand, ManagedState } from './managed-state-contracts.js';
import type { ManagedSession } from './managed-session-contracts.js';
import type { ManagedSlot } from './managed-slot-contracts.js';
import type { ReleaseStep } from '../contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';
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
import { metadataReserveBytes, sameMetadataFile } from './managed-metadata.js';
import { assertManagedHistory, captureManagedHistory } from './managed-history.js';
import { versionAliasBuildEnvironment, versionAliasCandidateEnvironment } from './version-alias.js';
import { protectedCompletionEnvironment } from './completion-state.js';
import { assertCompletionInput } from './completion-input.js';
import { isKnownProcessFailureCode, summarizeProcessFailure } from './managed-process-diagnostics.js';
import { ManagedStartupTiming, type CommandPreparationReport } from './managed-startup-timing.js';

function lifecycleError(error: unknown, reason: string, step: string, phase?: string, preparation?: CommandPreparationReport): ReleaseError {
  if (error instanceof ReleaseError) return error;
  const value = record(error), code = value.code;
  const known = isKnownProcessFailureCode(code), failure = summarizeProcessFailure(error);
  // 只保留固定操作名和元数据文件名，帮助定位失败边界，不暴露消息、完整路径或参数。
  const syscall = typeof value.syscall === 'string' && ['open', 'read', 'write', 'rename', 'unlink', 'lstat', 'stat', 'statfs', 'mkdir', 'scandir'].includes(value.syscall) ? value.syscall : undefined;
  const file = typeof value.path === 'string' ? basename(value.path) : undefined;
  return new ReleaseError('PROCESS_STATE_UNKNOWN', { reason, step,
    ...(preparation ? { preparation } : {}),
    ...(Object.keys(failure).length ? { failure } : {}),
    ...(known ? { causeCode: code, ...(phase ? { causePhase: phase } : {}), ...(syscall ? { causeSyscall: syscall } : {}),
      ...(file && ['state.json', '.state.json.next', 'terminal.json', '.terminal.json.next'].includes(file) ? { causeFile: file } : {}) } : {}) });
}

function witnessNoStart(command: ManagedCommand, binding: string, reason: NonNullable<ManagedCommand['notStarted']>['reason']): void {
  command.status = 'stopped';
  command.observationComplete = true;
  command.notStarted = { schemaVersion: 1, reason, binding, observedAt: new Date().toISOString() };
}

const isObservationDeadline = (error: unknown): error is ReleaseError => error instanceof ReleaseError
  && error.code === 'BUDGET_UNKNOWN' && error.details.reason === 'OBSERVATION_DEADLINE';

class ManagedProcess implements ExecutionLifecycle {
  private tail = Promise.resolve();
  private terminal: TerminalWriter | undefined;
  private observation: { command: ManagedCommand; executing: boolean; closing: boolean } | undefined;
  private startingObservation = false;
  private requestActive = false;
  private commandStarts = 0;
  constructor(readonly slot: ManagedSlot, readonly state: ManagedState, readonly budget: BudgetMonitor) {}
  async persist(): Promise<void> {
    await this.terminal?.assertOwned();
    await this.slot.store.writeState(this.state, async prepared => { await this.terminal?.prepareState(prepared); });
    await this.terminal?.acceptState(this.state);
  }
  async guard(): Promise<void> {
    assertNoGitContext(); await assertManagedPaths(this.slot.paths); await this.slot.lock.assertOwned(); await assertManagedHistory(this.slot.paths, this.state);
    if (this.state.completion && this.state.completion.status !== 'completed' && this.state.completionInput)
      await assertCompletionInput(this.slot.paths.checkoutRoot, this.state.completionInput);
  }
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
    if (this.observation || this.startingObservation || this.requestActive) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_NESTED' });
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
    let deadline = isObservationDeadline(failure) ? failure : undefined;
    try { try {
      const observations = command.observations ?? [];
      command.status = observations.every(hasVerifiedManagedClosure) ? 'closed' : 'stopped';
      command.observationComplete = true;
      if (this.observation.executing || !hasObservationStopWitness(command)) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_STOP_UNPROVEN' });
      await this.guard();
      if (!deadline) {
        try { await this.budget.sample(); }
        catch (error) { if (!isObservationDeadline(error)) throw error; deadline = error; }
      }
      await terminal.assertOwned();
      command.terminalSha256 = await terminal.write(command);
      // 截止仍令操作失败。原记录可与独立停止回执归并，无须等待再次扫描整个槽。
      if (!deadline) await this.persist();
    } catch (error) {
      if (!command.terminalSha256) {
        command.status = 'unknown'; command.observationComplete = false;
        try { await this.persist(); } catch { /* 耐久意图保留 UNKNOWN，不用内存停止事实解锁。 */ }
      }
      if (!failed) throw deadline ?? lifecycleError(error, 'OBSERVATION_COMMIT_FAILED', command.name);
      // 原解析、权限或取消错误优先；无批次证明时状态仍然未知。
    }
    if (failed) throw failure;
    if (deadline) throw deadline;
    return value as T;
    } finally { this.observation = undefined; }
  }
  /** HTTP 自持有连接；只复用管理门禁和预算，不生成虚构的进程意图或关闭证明。 */
  async observeRequest<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.observation || this.startingObservation || this.requestActive || this.commandStarts) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'REQUEST_OVERLAP' });
    this.requestActive = true;
    try {
      assertActive(signal); await this.guard(); await this.assertClosed();
      const value = await this.budget.run(async combined => {
        await this.guard(); await this.assertClosed(); assertActive(combined);
        return operation(combined);
      }, signal);
      await this.guard(); await this.assertClosed(); assertActive(signal);
      return value;
    } finally { this.requestActive = false; }
  }
  async execute(runner: CommandRunner, name: string, spec: CommandSpec, observer?: CommandObserver): Promise<ExecutionResult> {
    if (this.startingObservation || this.requestActive) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_NESTED' });
    // 第一次异步准入前预约，HTTP 不能在命令意图尚未入列时抢占同一预算。
    this.commandStarts++;
    try { return await this.executeCommand(runner, name, spec, observer); }
    finally { this.commandStarts--; }
  }
  private async executeCommand(runner: CommandRunner, name: string, spec: CommandSpec, observer?: CommandObserver): Promise<ExecutionResult> {
    const batch = this.observation;
    if (this.startingObservation || this.requestActive) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'OBSERVATION_NESTED' });
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
    let admitted = false;
    try { return await this.budget.run(async signal => {
      admitted = true;
      const failed = new AbortController(), combined = AbortSignal.any([signal, failed.signal]);
      let failure: unknown, running: RunningCommand | undefined;
      let phase: 'command' | 'terminal' | 'closed-state' = 'command';
      let requestedTermination: 'abort' | 'timeout' | undefined;
      const timing = new ManagedStartupTiming();
      const enqueue = (operation: () => Promise<void>) => {
        this.tail = this.tail.then(operation).catch((error: unknown) => { failure ??= error; command.observationComplete = false; failed.abort(); });
      };
      try {
        const environment = spec.environment ?? { mode: 'inherit' as const };
        if (combined.aborted) {
          // 启动意图已耐久化，但此分支从未调用 runner；独立封印这一事实，不伪造 OS closure。
          witnessNoStart(command, binding, 'cancelled-before-runner');
          phase = 'terminal';
          if (!batch) command.terminalSha256 = await terminal.write(command);
          phase = 'closed-state';
          if (!batch) await this.persist();
          throw new ReleaseError('CANCELLED');
        }
        running = runner.start({ ...spec, signal: combined, ownedScope: { start: 'manual', binding },
          environment: { ...environment, values: { ...environment.values, ...isolatedGitEnvironment(),
            ...versionAliasBuildEnvironment(this.slot.source.config, this.slot.source.sha, this.slot.source.configSha256),
            ...(this.state.prebuilt ? versionAliasCandidateEnvironment(this.slot.source.config, this.state.prebuilt) : {}),
            ...protectedCompletionEnvironment(this.slot.source, this.state.prebuilt, this.state.completion, name),
            FORGE_RELEASE_COMMAND: this.state.command, FORGE_RELEASE_SHA: this.slot.source.sha } } }, event => {
          observer?.(event);
          if (event.type === 'termination-requested' && (event.reason === 'abort' || event.reason === 'timeout')) { requestedTermination = event.reason; timing.stopped(); }
          if (event.type === 'spawned') enqueue(async () => {
            command.pid = event.pid; command.status = 'spawned';
            if (!batch) await timing.measure('spawned-journal', () => this.persist());
          });
          if (event.type === 'scope-ready') { timing.queued(); enqueue(async () => {
            timing.dequeued();
            const authorize = running?.authorizeStart?.bind(running);
            if (event.binding !== binding || !authorize) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'SCOPE_BINDING' });
            command.identity = { pid: event.identity.pid, startToken: event.identity.startToken };
            command.scope = { scopeId: event.scopeId, binding }; command.status = 'identified';
            // 取消只禁止放行 argv；已收到的绑定事实仍供真实关闭结果核验，不据此放行执行。
            if (combined.aborted || requestedTermination) return;
            await timing.measure('guard', () => this.guard());
            await timing.measure('budget', () => this.budget.sample(timing.budget));
            await timing.measure('identified-journal', async () => { if (batch) await terminal?.assertOwned(); else await this.persist(); });
            // 写入、预算和所有权任一步失败都不放行真实 argv。
            await timing.measure('guard', () => this.guard());
            // 命令自身的期限不会撤销 combined；超时后的队列仍需收尾，但不能再放行 argv。
            if (combined.aborted) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'START_CANCELLED' });
            if (requestedTermination) return;
            timing.requested();
            await timing.measure('authorization', authorize);
            timing.acknowledged();
          }); }
        });
        const result = await running.result; await this.tail;
        timing.settled();
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
        if (failure !== undefined) throw lifecycleError(failure, 'JOURNAL_FAILED', name, undefined, timing.snapshot());
        phase = 'closed-state';
        if (!batch) await this.persist();
        if (!hasVerifiedManagedStop(command)) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'CLOSURE_UNPROVEN', commandId: command.id, step: name,
          termination: result.terminationReason, exitCode: result.exitCode, identified: !!command.identity,
          ...(result.ownedScope ? { scopeReason: result.ownedScope.reason, empty: result.ownedScope.empty } : {}),
          diagnostics: result.diagnostics.map(item => summarizeProcessFailure(item)) });
        // runner 的原始分类保存在回执；已验证受控停止时，执行结果仍保留取消/超时的原意。
        return { ...result, ...(command.status === 'stopped' && requestedTermination ? { terminationReason: requestedTermination } : {}), preparation: timing.snapshot() };
      } catch (error) {
        failed.abort(); await running?.terminate(); await this.tail;
        if (batch ? !hasVerifiedManagedStop(command) : !command.terminalSha256) {
          command.status = 'unknown'; command.observationComplete = false; delete command.notStarted;
        }
        if (!batch) try { await this.persist(); } catch { /* 最后已持久化的意图仍不是关闭证明，不能释放槽。 */ }
        throw lifecycleError(error, 'PROCESS_LIFECYCLE_FAILED', name, phase);
      }
    }, spec.signal); } catch (error) {
      if (error instanceof ReleaseError && ['BUDGET_UNKNOWN', 'BUDGET_EXCEEDED'].includes(error.code) && !admitted) {
        witnessNoStart(command, binding, 'budget-before-runner');
        if (!batch) {
          try {
            await this.guard(); command.terminalSha256 = await terminal.write(command);
            if (!isObservationDeadline(error)) await this.persist();
          }
          catch {
            if (!command.terminalSha256) {
              command.status = 'unknown'; command.observationComplete = false; delete command.notStarted;
            }
            // 持久化失败时，保留原预算错误；磁盘单独核验停止回执。
          }
        }
      } else if (error instanceof ReleaseError && ['BUDGET_UNKNOWN', 'BUDGET_EXCEEDED'].includes(error.code) && command.closure) {
        // 保留预算错误，同时给出已记录的命令结果；最终观察失败不能抹掉已发生的超时或非零退出。
        throw new ReleaseError(error.code, { ...error.details, step: name,
          commandTermination: command.closure.requestedTermination ?? command.closure.termination,
          commandExitCode: command.closure.exitCode, commandObservedAt: command.closure.observedAt });
      }
      throw error;
    } finally { if (batch) batch.executing = false; }
  }
}
export async function createManagedSession(slot: ManagedSlot, command: 'check' | 'publish' | 'verify', signal?: AbortSignal): Promise<ManagedSession> {
  if (slot.source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const resumed = command === 'check' ? undefined : slot.completionResume;
  const history = await captureManagedHistory(slot.paths);
  for (const required of slot.drainedAcceptance?.history ?? []) {
    if (!history.some(reference => reference.path === required.path && sameMetadataFile(reference.file, required.file)))
      throw new ReleaseError('SLOT_STATE', { reason: 'DRAINED_ACCEPTANCE_HISTORY_CHANGED' });
  }
  const state: ManagedState = { schemaVersion: 3, slotId: slot.slotId, runId: slot.runId, source: slot.source, command,
    coordinator: slot.coordinator, host: slot.coordinatorLease?.host ?? await readRetirementHost(signal),
    ...(slot.coordinatorLease ? { coordinatorLease: 'native-directory' as const } : {}),
    history, stage: 'admission', status: 'running', processes: [],
    ...(resumed ? { prebuilt: structuredClone(resumed.prebuilt), completion: structuredClone(resumed.completion), completionInput: structuredClone(resumed.input) } : {}),
    effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted', ...(resumed ? { deploymentCreate: resumed.prebuilt.createEffect,
      deploymentPromote: resumed.prebuilt.promoteEffect, ...(resumed.prebuilt.versionAlias ? { versionAliasAssign: resumed.prebuilt.versionAlias.effect } : {}) } : {}) } };
  const budget = new BudgetMonitor(slot.paths, slot.source.config.source, undefined, metadataReserveBytes), lifecycle = new ManagedProcess(slot, state, budget), steps: ReleaseStep[] = [];
  await lifecycle.persist();
  return { slot, command, state, budget, steps, execution: createManagedExecution(slot.paths.checkoutRoot, slot.source.config, signal, steps, lifecycle),
    persist: () => lifecycle.persist(), assertClosed: () => lifecycle.assertClosed(), assertStopped: () => lifecycle.assertStopped(),
    executionAt: cwd => { if (!within(slot.paths.slotRoot, resolve(cwd))) throw new ReleaseError('SLOT_PATH'); return createManagedExecution(cwd, slot.source.config, signal, steps, lifecycle); } };
}
