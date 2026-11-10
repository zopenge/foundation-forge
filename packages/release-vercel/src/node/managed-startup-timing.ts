import { performance } from 'node:perf_hooks';

export interface BudgetSampleTiming { queueMs: number; scanMs: number }
type WorkPhase = 'spawned-journal' | 'guard' | 'budget' | 'identified-journal' | 'authorization';
type Phase = WorkPhase | 'waiting-for-scope' | 'scope-ready-queue' | 'execution';
export interface CommandPreparationReport {
  readonly authorization: 'not-requested' | 'requested' | 'acknowledged';
  readonly phaseAtTermination?: Phase;
  readonly terminationAfterMs?: number;
  readonly elapsedMs: number;
  readonly scopeReadyQueueMs: number;
  readonly guardMs: number;
  readonly journalMs: number;
  readonly budgetMs: number;
  readonly authorizationMs: number;
  readonly budgetQueueMs: number;
  readonly budgetScanMs: number;
}

/** 固定字段的内存计时；队列与日志区间可能重叠，不写逐事件日志或改变期限。 */
export class ManagedStartupTiming {
  readonly budget: BudgetSampleTiming = { queueMs: 0, scanMs: 0 };
  private readonly started = performance.now();
  private ended: number | undefined;
  private phase: Phase = 'waiting-for-scope';
  private queuedAt: number | undefined;
  private scopeReadyQueueMs = 0;
  private authorization: CommandPreparationReport['authorization'] = 'not-requested';
  private termination: { phaseAtTermination: Phase; terminationAfterMs: number } | undefined;
  private readonly totals = { guardMs: 0, journalMs: 0, budgetMs: 0, authorizationMs: 0 };
  queued(): void { this.queuedAt = performance.now(); }
  dequeued(): void {
    if (this.queuedAt !== undefined) this.scopeReadyQueueMs = performance.now() - this.queuedAt;
    this.queuedAt = undefined;
  }
  requested(): void { this.authorization = 'requested'; }
  acknowledged(): void { this.authorization = 'acknowledged'; this.ended = performance.now(); this.phase = 'execution'; }
  stopped(): void {
    this.termination ??= { phaseAtTermination: this.phase === 'waiting-for-scope' && this.queuedAt !== undefined ? 'scope-ready-queue' : this.phase,
      terminationAfterMs: performance.now() - this.started };
  }
  settled(): void { this.ended ??= performance.now(); }
  async measure<T>(phase: WorkPhase, operation: () => Promise<T>): Promise<T> {
    const previous = this.phase, started = performance.now(); this.phase = phase;
    try { return await operation(); }
    finally {
      const metric = phase === 'guard' ? 'guardMs' : phase === 'budget' ? 'budgetMs' : phase === 'authorization' ? 'authorizationMs' : 'journalMs';
      this.totals[metric] += performance.now() - started; this.phase = previous;
    }
  }
  snapshot(): CommandPreparationReport {
    return { authorization: this.authorization, ...this.termination, elapsedMs: (this.ended ?? performance.now()) - this.started,
      scopeReadyQueueMs: this.scopeReadyQueueMs, ...this.totals, budgetQueueMs: this.budget.queueMs, budgetScanMs: this.budget.scanMs };
  }
}
