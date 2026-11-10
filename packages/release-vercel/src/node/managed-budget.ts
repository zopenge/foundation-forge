import type { ManagedSourceConfig, ReleaseBudget } from '../contracts.js';
import type { ManagedPaths } from './release-context.js';
import { performance } from 'node:perf_hooks';
import { ReleaseError } from './errors.js';
import { measureManagedUsage, measureManagedUsageOnce, type ManagedUsageProgress } from './managed-io.js';
import { assertManagedPaths } from './managed-paths.js';
import type { BudgetSampleTiming } from './managed-startup-timing.js';

export interface BudgetObservation { readonly bytes: number; readonly freeBytes: number; readonly observedAt: number }
export async function observeBudget(paths: ManagedPaths, config: ManagedSourceConfig, scan = measureManagedUsageOnce): Promise<BudgetObservation> {
  const controller = new AbortController();
  const started = performance.now(), budgetMs = 30_000 + config.sampleIntervalMs;
  const progress: ManagedUsageProgress = { entriesVisited: 0, phase: 'path-guard' };
  let scanAttempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_accept, reject) => {
    timer = setTimeout(() => {
      const error = new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE', budgetMs,
        elapsedMs: Math.floor(performance.now() - started), observedAt: new Date().toISOString(),
        scanAttempts, entriesVisited: progress.entriesVisited, phase: progress.phase });
      controller.abort(); reject(error);
    }, budgetMs);
  });
  const observation = async () => {
    await assertManagedPaths(paths);
    const value = await measureManagedUsage(paths, controller.signal, (paths, signal, progress) => {
      scanAttempts++; if (progress) { progress.entriesVisited = 0; progress.phase = 'scan'; }
      return scan(paths, signal, progress);
    }, progress);
    return { ...value, observedAt: Date.now() };
  };
  try { return await Promise.race([observation(), deadline]); }
  catch (error) { if (error instanceof ReleaseError) throw error; throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_FAILED' }); }
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
