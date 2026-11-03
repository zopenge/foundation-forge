import { performance } from 'node:perf_hooks';
import type { ReleaseCompletionAttempt, ReleaseCompletionJobResult, ReleaseCompletionState, RunReleaseOptions } from '../contracts.js';
import type { ManagedSession } from './release-context.js';
import { ReleaseError } from './errors.js';
import { diagnostic } from './workspace-release.js';
import { assertRecordedPrebuiltArtifact } from './prebuilt-artifact.js';
import { observePrebuiltCandidate } from './prebuilt-recovery.js';
import { createPrebuiltTransport } from './prebuilt-vercel.js';
import { managedPrebuiltContext } from './prebuilt-state.js';
import { parseCompletionState } from './completion-state.js';
import { hasVerifiedManagedClosure } from './managed-closure.js';
import { assertCompletionInput } from './completion-input.js';

/** 沿用原锁、runner 和日志，只追加业务尝试；本地停止不是业务成功。 */
export async function runCompletion(session: ManagedSession, options: Pick<RunReleaseOptions, 'transport' | 'retryCompletion'>,
  assertFrozen: () => Promise<void>): Promise<void> {
  const { source } = session.slot, config = source.config;
  if (session.command === 'check') return;
  if (!config.completion) {
    if (options.retryCompletion) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMPLETION_NOT_CONFIGURED' });
    return;
  }
  const selected = parseCompletionState(session.state.completion, source, session.state.prebuilt);
  if (!selected) {
    if (session.command === 'verify' && !options.retryCompletion && session.state.prebuilt?.promoteEffect === 'not-attempted') return;
    throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'COMPLETION_INTENT_MISSING' });
  }
  if (selected.status !== 'completed' && session.command === 'verify' && !options.retryCompletion) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'COMPLETION_RETRY_REQUIRED' });
  if (selected.status !== 'completed' && selected.attempts.length >= 32) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'COMPLETION_ATTEMPT_LIMIT' });
  const prebuiltContext = managedPrebuiltContext(session);
  if (!prebuiltContext || !config.delivery) throw new ReleaseError('SOURCE_UNSUPPORTED');
  const transport = options.transport ?? createPrebuiltTransport(session.execution, config, false);
  const guard = async () => {
    await session.slot.lock.assertOwned(); await assertFrozen(); await session.assertClosed(); await session.budget.sample();
    const candidate = session.state.prebuilt;
    if (!candidate || candidate.promoteEffect === 'not-attempted') throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'COMPLETION_PRODUCTION_UNPROVEN' });
    if (session.state.completion?.status !== 'completed') {
      if (!session.state.completionInput) throw new ReleaseError('SLOT_STATE', { reason: 'COMPLETION_INPUT_BINDING' });
      await assertCompletionInput(session.execution.cwd, session.state.completionInput);
    }
    await assertRecordedPrebuiltArtifact(session.execution.cwd, config, candidate, session.execution.signal);
    const found = await observePrebuiltCandidate(config, candidate, transport, session.execution.signal);
    if (!found.observed.promotionVerified) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'COMPLETION_PRODUCTION_UNPROVEN' });
    await prebuiltContext.save(found.observed); await session.slot.lock.assertOwned();
  };
  const save = async (value: ReleaseCompletionState) => {
    parseCompletionState(value, source, session.state.prebuilt); session.state.completion = value; await session.persist();
  };
  session.state.stage = 'completion'; await session.persist(); await guard();
  if (selected.status === 'completed') return;
  const started = performance.now(), startedAt = new Date().toISOString();
  let attempt: ReleaseCompletionAttempt = { runId: session.state.runId, startedAt, status: 'running', jobs: [] };
  const update = async () => save({ ...selected, status: attempt.status, attempts: [...selected.attempts, attempt] });
  await update();
  let jobStart: number | undefined, beforeCommands = 0;
  try {
    session.state.stage = 'admission'; await session.persist();
    for (const [index, check] of config.delivery.admission.entries())
      await session.execution.run(`admission:completion:${index}`, check, 'ADMISSION_FAILED');
    session.state.stage = 'completion'; await session.persist();
    for (const [index, check] of config.completion.jobs.entries()) {
      await guard();
      const job: ReleaseCompletionJobResult = { index, startedAt: new Date().toISOString(), status: 'running' };
      attempt = { ...attempt, jobs: [...attempt.jobs, job] }; await update();
      jobStart = performance.now(); beforeCommands = session.state.processes.length;
      await session.execution.run(`completion:${index}`, check, 'COMPLETION_FAILED');
      const command = session.state.processes.slice(beforeCommands).find(item => item.name === `completion:${index}`);
      if (!command || !hasVerifiedManagedClosure(command) || command.closure?.exitCode !== 0)
        throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'COMPLETION_CLOSURE_UNPROVEN' });
      await guard();
      attempt = { ...attempt, jobs: [...attempt.jobs.slice(0, -1), { ...job, status: 'completed', commandId: command.id,
        finishedAt: new Date().toISOString(), durationMs: performance.now() - jobStart }] };
      jobStart = undefined; await update();
    }
    await guard();
    attempt = { ...attempt, status: 'completed', finishedAt: new Date().toISOString(), durationMs: performance.now() - started };
    await update();
  } catch (error) {
    let stopped = false;
    try { await session.assertStopped(); stopped = true; } catch { /* 原生关闭未证实，尝试保持 unknown。 */ }
    const failure = diagnostic(error), status = stopped ? 'failed' as const : 'unknown' as const;
    if (jobStart !== undefined) {
      const job = attempt.jobs.at(-1), command = session.state.processes.slice(beforeCommands).find(item => item.name === `completion:${job?.index}`);
      if (job) attempt = { ...attempt, jobs: [...attempt.jobs.slice(0, -1), { ...job, status,
        ...(command ? { commandId: command.id } : {}), finishedAt: new Date().toISOString(), durationMs: performance.now() - jobStart, error: failure }] };
    }
    attempt = { ...attempt, status, finishedAt: new Date().toISOString(), durationMs: performance.now() - started, error: failure };
    try { await update(); } catch { /* 原始意图或最后持久状态仍保留，首错不被清理错误替换。 */ }
    throw error;
  }
}
