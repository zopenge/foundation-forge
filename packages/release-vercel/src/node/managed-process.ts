import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { CommandObserver, CommandResult, CommandRunner, CommandSpec, RunningCommand } from '@openge/forge-command-runner';
import type { ExecutionLifecycle, ManagedCommand, ManagedSession, ManagedSlot, ManagedState } from './release-context.js';
import type { ReleaseStep } from '../contracts.js';
import { ReleaseError } from './errors.js';
import { within } from './managed-io.js';
import { assertManagedPaths } from './managed-paths.js';
import { BudgetMonitor } from './managed-budget.js';
import { Execution } from './execution.js';
import { assertNoGitContext, isolatedGitEnvironment } from './git-context.js';
import { hasVerifiedManagedClosure } from './managed-closure.js';

class ManagedProcess implements ExecutionLifecycle {
  private tail = Promise.resolve();
  constructor(readonly slot: ManagedSlot, readonly state: ManagedState, readonly budget: BudgetMonitor) {}
  async persist(): Promise<void> { await this.slot.store.writeState(this.state); }
  async guard(): Promise<void> { assertNoGitContext(); await assertManagedPaths(this.slot.paths); await this.slot.lock.assertOwned(); }
  async assertClosed(): Promise<void> {
    if (!this.state.processes.every(hasVerifiedManagedClosure)) throw new ReleaseError('PROCESS_STATE_UNKNOWN');
  }
  async execute(runner: CommandRunner, name: string, spec: CommandSpec, observer?: CommandObserver): Promise<CommandResult> {
    await this.guard(); await this.assertClosed();
    const command: ManagedCommand = { id: randomUUID(), name, status: 'intent', descendants: [], observationComplete: false };
    const binding = `${this.state.runId}:${command.id}:${randomUUID()}`;
    this.state.processes.push(command); await this.persist();
    return this.budget.run(async signal => {
      const failed = new AbortController(), combined = AbortSignal.any([signal, failed.signal]);
      let failure: unknown, running: RunningCommand | undefined;
      const enqueue = (operation: () => Promise<void>) => {
        this.tail = this.tail.then(operation).catch((error: unknown) => { failure ??= error; command.observationComplete = false; failed.abort(); });
      };
      try {
        const environment = spec.environment ?? { mode: 'inherit' as const };
        running = runner.start({ ...spec, signal: combined, ownedScope: { start: 'manual', binding },
          environment: { ...environment, values: { ...environment.values, ...isolatedGitEnvironment(), FORGE_RELEASE_COMMAND: this.state.command, FORGE_RELEASE_SHA: this.slot.source.sha } } }, event => {
          observer?.(event);
          if (event.type === 'spawned') enqueue(async () => { command.pid = event.pid; command.status = 'spawned'; await this.persist(); });
          if (event.type === 'scope-ready') enqueue(async () => {
            if (event.binding !== binding || !running?.authorizeStart || combined.aborted) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'SCOPE_BINDING' });
            command.identity = { pid: event.identity.pid, startToken: event.identity.startToken };
            command.scope = { scopeId: event.scopeId, binding }; command.status = 'identified';
            await this.guard(); await this.budget.sample(); await this.persist();
            // 写入、预算和所有权任一步失败都不放行真实 argv。
            await this.guard(); if (combined.aborted) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'START_CANCELLED' });
            await running.authorizeStart();
          });
        });
        const result = await running.result; await this.tail;
        command.observationComplete = failure === undefined && result.ownedScope?.status === 'closed';
        command.closure = { observedAt: new Date().toISOString(), exitCode: result.exitCode, termination: result.terminationReason,
          ...(result.ownedScope ? { ownedScope: result.ownedScope } : {}) };
        command.status = result.terminationReason === 'exit' && command.observationComplete ? 'closed' : 'unknown';
        if (!hasVerifiedManagedClosure(command)) { command.status = 'unknown'; command.observationComplete = false; }
        await this.persist();
        if (failure !== undefined) throw failure instanceof ReleaseError ? failure : new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'JOURNAL_FAILED', step: name });
        if (command.status !== 'closed') throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'CLOSURE_UNPROVEN', commandId: command.id, step: name,
          termination: result.terminationReason, exitCode: result.exitCode, identified: !!command.identity,
          ...(result.ownedScope ? { scopeReason: result.ownedScope.reason, empty: result.ownedScope.empty } : {}),
          diagnostics: result.diagnostics.map(item => ({ code: item.code, stage: item.details.stage })) });
        return result;
      } catch (error) {
        failed.abort(); await running?.terminate(); await this.tail;
        command.status = 'unknown'; command.observationComplete = false;
        try { await this.persist(); } catch { /* 最后已持久化的意图仍不是关闭证明，不能释放槽。 */ }
        throw error instanceof ReleaseError ? error : new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'PROCESS_LIFECYCLE_FAILED', step: name });
      }
    }, spec.signal);
  }
}
export async function createManagedSession(slot: ManagedSlot, command: 'check' | 'publish' | 'verify', signal?: AbortSignal): Promise<ManagedSession> {
  if (slot.source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const state: ManagedState = { schemaVersion: 2, slotId: slot.slotId, runId: slot.runId, source: slot.source, command,
    coordinator: slot.coordinator, stage: 'admission', status: 'running', processes: [], effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } };
  const budget = new BudgetMonitor(slot.paths, slot.source.config.source), lifecycle = new ManagedProcess(slot, state, budget), steps: ReleaseStep[] = [];
  await lifecycle.persist();
  return { slot, command, state, budget, steps, execution: new Execution(slot.paths.checkoutRoot, slot.source.config, signal, steps, lifecycle),
    persist: () => lifecycle.persist(), assertClosed: () => lifecycle.assertClosed(),
    executionAt: cwd => { if (!within(slot.paths.slotRoot, resolve(cwd))) throw new ReleaseError('SLOT_PATH'); return new Execution(cwd, slot.source.config, signal, steps, lifecycle); } };
}
