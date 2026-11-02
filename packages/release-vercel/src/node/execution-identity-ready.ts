import { performance } from 'node:perf_hooks';
import { ProcessControlError, type ProcessIdentityReader } from '@openge/forge-process-control';
import { assertActive, ReleaseError } from './errors.js';

/** 只记住当前进程内的原生能力就绪事实；实际命令身份始终另行新读。 */
export class ExecutionIdentityReady {
  private ready = false;
  constructor(private readonly reader: ProcessIdentityReader) {}

  async prepare(step: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    assertActive(signal);
    if (this.ready) return timeoutMs;
    const started = performance.now(), controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let expired = false, stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new ReleaseError('CANCELLED'));
      signal?.addEventListener('abort', stop, { once: true });
    });
    const deadline = Math.min(timeoutMs, 10_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true; controller.abort();
        reject(new ReleaseError(deadline === timeoutMs ? 'COMMAND_TIMEOUT' : 'SOURCE_UNSUPPORTED',
          { step, reason: 'NATIVE_IDENTITY_DEADLINE' }));
      }, deadline);
    });
    try {
      const observed = await Promise.race([this.reader.readIdentity({ pid: process.pid, signal: combined }), stopped, timed]);
      assertActive(signal);
      if (observed.status !== 'FOUND' || observed.identity.pid !== process.pid
        || typeof observed.identity.startToken !== 'string' || !observed.identity.startToken.trim()) {
        throw new ReleaseError('SOURCE_UNSUPPORTED', { step, reason: 'NATIVE_IDENTITY_UNAVAILABLE' });
      }
      const elapsed = performance.now() - started;
      if (expired || elapsed >= deadline) throw new ReleaseError(deadline === timeoutMs ? 'COMMAND_TIMEOUT' : 'SOURCE_UNSUPPORTED',
        { step, reason: 'NATIVE_IDENTITY_DEADLINE' });
      const remaining = Math.floor(timeoutMs - elapsed);
      if (remaining <= 0) throw new ReleaseError('COMMAND_TIMEOUT', { step });
      this.ready = true;
      return remaining;
    } catch (error) {
      assertActive(signal);
      if (expired) throw new ReleaseError(deadline === timeoutMs ? 'COMMAND_TIMEOUT' : 'SOURCE_UNSUPPORTED',
        { step, reason: 'NATIVE_IDENTITY_DEADLINE' });
      if (error instanceof ReleaseError) throw error;
      const details = error instanceof ProcessControlError ? {
        causeCode: error.code,
        ...(typeof error.details.stage === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.details.stage) ? { stage: error.details.stage } : {}),
        ...(typeof error.details.nativeCode === 'number' && Number.isSafeInteger(error.details.nativeCode) ? { nativeCode: error.details.nativeCode } : {}),
      } : {};
      throw new ReleaseError('SOURCE_UNSUPPORTED', { step, reason: 'NATIVE_IDENTITY_UNAVAILABLE', ...details });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', stop); controller.abort();
    }
  }
}
