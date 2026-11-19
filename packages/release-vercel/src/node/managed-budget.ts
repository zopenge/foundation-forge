import type { ManagedSourceConfig, ReleaseBudget } from '../contracts.js';
import type { ManagedPaths } from './managed-state-contracts.js';
import { performance } from 'node:perf_hooks';
import { ReleaseError } from './errors.js';
import { measureManagedUsage, measureManagedUsageOnce, type ManagedUsageProgress } from './managed-io.js';
import { assertManagedPaths } from './managed-paths.js';
import type { BudgetSampleTiming } from './managed-startup-timing.js';
import { ScanFailureWitness } from './managed-scan-witness.js';

export interface BudgetObservation { readonly bytes: number; readonly freeBytes: number; readonly observedAt: number }
interface ScanAttemptRecord {
  readonly witness: ScanFailureWitness;
  selectedError?: unknown;
  readonly attempt: number;
  readonly started: number;
  ended?: number;
  outcome: 'pending' | 'resolved' | 'rejected';
  retried: boolean;
  entriesVisited: number;
  phase: ManagedUsageProgress['phase'];
  failure?: Readonly<Record<string, string>>;
}
const scanFailureReasons = new Set(['IO_OBSERVATION', 'DIRECTORY_REPLACED', 'OBSERVATION_DEADLINE', 'OBSERVATION_FAILED',
  'ROOT_REPLACED', 'LINK_REPLACED', 'ENTRY_LIMIT', 'EXTERNAL_LINK', 'LINK_TARGET_UNKNOWN', 'LINK_ANCESTOR_TYPE',
  'LINK_RESOLUTION_LIMIT', 'ANCHOR_TYPE', 'FILE_TYPE', 'SIZE_OVERFLOW', 'VOLUME_SIZE', 'CHECKOUT_UNCONFIRMED']);
const scanFailureReason = (value: unknown): string => typeof value === 'string' && scanFailureReasons.has(value) ? value : 'OTHER';
function scanFailure(error: unknown): Readonly<Record<string, string>> {
  const details = error instanceof ReleaseError ? error.details : {};
  const failure: Record<string, string> = { reason: scanFailureReason(details.reason) };
  if (details.ioCode !== undefined) failure.ioCode = typeof details.ioCode === 'string'
    && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(details.ioCode) ? details.ioCode : 'OTHER';
  if (typeof details.change === 'string' && ['identity', 'link', 'type', 'namespace'].includes(details.change)) failure.change = details.change;
  if (typeof details.scope === 'string' && ['slot-root', 'checkout-root', 'checkout-metadata', 'checkout-entry', 'slot-entry'].includes(details.scope)) failure.scope = details.scope;
  if (details.rescanBlockedBy !== undefined) failure.rescanBlockedBy = scanFailureReason(details.rescanBlockedBy);
  return failure;
}
export async function observeBudget(paths: ManagedPaths, config: ManagedSourceConfig, scan = measureManagedUsageOnce): Promise<BudgetObservation> {
  const controller = new AbortController();
  const started = performance.now(), budgetMs = config.observationTimeoutMs ?? (30_000 + config.sampleIntervalMs);
  const progress: ManagedUsageProgress = { entriesVisited: 0, phase: 'path-guard' };
  let scanAttempts = 0;
  const attempts: ScanAttemptRecord[] = [];
  const snapshotAttempts = (now: number) => attempts.map(attempt => {
    const failureWitness = attempt.witness.snapshot(attempt.selectedError, attempt.outcome === 'rejected');
    return {
      attempt: attempt.attempt, startedOffsetMs: attempt.started - started,
      ...(attempt.ended === undefined ? {} : { endedOffsetMs: attempt.ended - started }),
      elapsedMs: (attempt.ended ?? now) - attempt.started, outcome: attempt.outcome, retried: attempt.retried,
      entriesVisited: attempt.outcome === 'pending' ? progress.entriesVisited : attempt.entriesVisited,
      phase: attempt.outcome === 'pending' ? progress.phase : attempt.phase,
      ...(attempt.failure ? { failure: { ...attempt.failure } } : {}),
      ...(Object.keys(failureWitness).length ? { failureWitness } : {}),
    };
  });
  let deadlineSnapshot: ReturnType<typeof snapshotAttempts> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineFailure = (now: number): ReleaseError => {
    // 先复制证据，避免同步 abort 监听或迟到的扫描改写截止快照。
    deadlineSnapshot = snapshotAttempts(now);
    const error = new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE', budgetMs,
      elapsedMs: Math.floor(now - started), observedAt: new Date().toISOString(),
      scanAttempts, entriesVisited: progress.entriesVisited, phase: progress.phase });
    controller.abort();
    return error;
  };
  const deadline = new Promise<never>((_accept, reject) => {
    timer = setTimeout(() => reject(deadlineFailure(performance.now())), budgetMs);
  });
  const observation = async () => {
    await assertManagedPaths(paths);
    const value = await measureManagedUsage(paths, controller.signal, async (paths, signal, progress) => {
      const previous = attempts.at(-1);
      // 只有原重扫流程确实开始下一轮，才记录前轮已重试；不重判错误或guard。
      if (previous) previous.retried = true;
      scanAttempts++; if (progress) { progress.entriesVisited = 0; progress.phase = 'scan'; }
      const attemptStarted = performance.now();
      const attempt: ScanAttemptRecord = { attempt: scanAttempts, started: attemptStarted, outcome: 'pending',
        retried: false, entriesVisited: 0, phase: 'scan', witness: new ScanFailureWitness(attemptStarted) };
      if (progress) progress.failureWitness = attempt.witness;
      attempts.push(attempt);
      try { const value = await scan(paths, signal, progress); attempt.outcome = 'resolved'; return value; }
      catch (error) { attempt.outcome = 'rejected'; attempt.failure = scanFailure(error); attempt.selectedError = error; throw error; }
      finally {
        attempt.ended = performance.now();
        if (progress) { attempt.entriesVisited = progress.entriesVisited; attempt.phase = progress.phase; }
      }
    }, progress, started + budgetMs);
    const now = performance.now();
    if (!controller.signal.aborted && now - started >= budgetMs) throw deadlineFailure(now);
    return { ...value, observedAt: Date.now() };
  };
  try { return await Promise.race([observation(), deadline]); }
  catch (error) {
    const observed = error instanceof ReleaseError ? error : new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_FAILED' });
    if (observed.code === 'BUDGET_UNKNOWN') throw new ReleaseError(observed.code, { budgetMs,
      elapsedMs: Math.floor(performance.now() - started), observedAt: new Date().toISOString(),
      scanAttempts, entriesVisited: progress.entriesVisited, phase: progress.phase, ...observed.details,
      scanAttemptDiagnostics: deadlineSnapshot ?? snapshotAttempts(performance.now()) });
    throw observed;
  }
  finally { clearTimeout(timer); }
}
export class BudgetMonitor {
  private count = 0;
  private maxBytes = 0;
  private minFree = Number.MAX_SAFE_INTEGER;
  private maxGap = 0;
  private lastObserved: number | undefined;
  private complete = true;
  private running = false;
  private sampling = Promise.resolve();
  constructor(readonly paths: ManagedPaths, readonly config: ManagedSourceConfig,
    private readonly observe: typeof observeBudget = observeBudget, private readonly reservedBytes = 0) {}
  async sample(timing?: BudgetSampleTiming): Promise<void> {
    const queued = performance.now();
    const observation = this.sampling.then(() => {
      if (timing) timing.queueMs += performance.now() - queued;
      return this.sampleNow(timing);
    });
    this.sampling = observation.catch(() => {});
    return observation;
  }
  private async sampleNow(timing?: BudgetSampleTiming): Promise<void> {
    let observation: BudgetObservation;
    const scan = timing ? async (...args: Parameters<typeof measureManagedUsageOnce>) => {
      const started = performance.now();
      try { return await measureManagedUsageOnce(...args); }
      finally { timing.scanMs += performance.now() - started; }
    } : undefined;
    try { observation = await this.observe(this.paths, this.config, scan); }
    catch (error) { this.complete = false; if (error instanceof ReleaseError) throw error; throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_FAILED' }); }
    this.count++; this.maxBytes = Math.max(this.maxBytes, observation.bytes); this.minFree = Math.min(this.minFree, observation.freeBytes);
    if (this.lastObserved !== undefined) this.maxGap = Math.max(this.maxGap, observation.observedAt - this.lastObserved);
    this.lastObserved = observation.observedAt;
    if (observation.bytes + this.reservedBytes > this.config.maxBytes || observation.freeBytes - this.reservedBytes < this.config.minFreeBytes) throw new ReleaseError('BUDGET_EXCEEDED', { bytes: observation.bytes, freeBytes: observation.freeBytes });
  }
  async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.running) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OVERLAPPING_OPERATION' });
    this.running = true;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let stopped = false, failure: unknown, wake: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let loop: Promise<void> | undefined;
    try {
      await this.sample();
      loop = (async () => {
        while (!stopped) {
          await new Promise<void>(accept => { wake = accept; timer = setTimeout(accept, this.config.sampleIntervalMs); });
          if (stopped) break;
          try { await this.sample(); } catch (error) { failure = error; controller.abort(); break; }
        }
      })();
      let result: T | undefined, operationFailed = false, operationError: unknown;
      try { result = await operation(combined); } catch (error) { operationFailed = true; operationError = error; }
      stopped = true; clearTimeout(timer); wake?.(); await loop;
      try { await this.sample(); } catch (error) { failure ??= error; }
      if (failure !== undefined) throw failure;
      if (operationFailed) throw operationError;
      return result as T;
    } finally {
      stopped = true; clearTimeout(timer); wake?.(); await loop; this.running = false;
    }
  }
  summary(): ReleaseBudget { return { sampleCount: this.count, maxObservedBytes: this.maxBytes, minObservedFreeBytes: this.count ? this.minFree : 0,
    maxObservationGapMs: this.maxGap, observationsComplete: this.complete && this.count > 0 }; }
}
