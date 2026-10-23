import type { ArtifactPublicationOptions, ArtifactRequestContext } from './contracts.js';
import { ArtifactPublicationError } from './errors.js';

export class OperationBudget {
  readonly #controller = new AbortController();
  readonly #deadline: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #aborted: Promise<never>;
  readonly #external: AbortSignal | undefined;
  readonly #externalAbort: () => void;
  #rejectAbort!: (error: ArtifactPublicationError) => void;
  #reason: ArtifactPublicationError | undefined;
  #unconfirmedResources = 0;

  constructor(options: ArtifactPublicationOptions) {
    this.#deadline = performance.now() + options.timeoutMilliseconds;
    this.#aborted = new Promise<never>((_resolve, reject) => { this.#rejectAbort = reject; });
    // 调用前就取消时也先接住拒绝，随后由操作入口返回结构化错误。
    void this.#aborted.catch(() => {});
    this.#timer = setTimeout(() => { this.stop(new ArtifactPublicationError('BUDGET_EXCEEDED')); }, options.timeoutMilliseconds);
    this.#external = options.signal;
    this.#externalAbort = () => { this.stop(new ArtifactPublicationError('OPERATION_ABORTED')); };
    this.#external?.addEventListener('abort', this.#externalAbort, { once: true });
    if (this.#external?.aborted) this.#externalAbort();
  }

  get pendingRequests(): number { return this.#pending.size + this.#unconfirmedResources; }
  get reason(): ArtifactPublicationError | undefined { return this.#reason; }

  markUnconfirmedResource(): void { this.#unconfirmedResources += 1; }

  async settleRequests(): Promise<void> { await Promise.allSettled([...this.#pending]); }

  stop(error: ArtifactPublicationError): void {
    if (this.#reason) return;
    this.#reason = error;
    this.#controller.abort(error);
    this.#rejectAbort(error);
  }

  assertActive(): void {
    if (!this.#reason && performance.now() >= this.#deadline) this.stop(new ArtifactPublicationError('BUDGET_EXCEEDED'));
    if (this.#reason) throw this.#reason;
  }

  context(): ArtifactRequestContext {
    this.assertActive();
    return { signal: this.#controller.signal, timeoutMilliseconds: Math.max(1, Math.ceil(this.#deadline - performance.now())) };
  }

  async run<T>(operation: () => Promise<T>, ownsRequest = true): Promise<T> {
    this.assertActive();
    const raw = Promise.resolve().then(() => { this.assertActive(); return operation(); });
    if (ownsRequest) {
      this.#pending.add(raw);
      void raw.then(() => { this.#pending.delete(raw); }, () => { this.#pending.delete(raw); });
    }
    const value = await Promise.race([raw, this.#aborted]);
    this.assertActive();
    return value;
  }

  endTransfers(): void { clearTimeout(this.#timer); }

  dispose(): void {
    this.endTransfers();
    this.#external?.removeEventListener('abort', this.#externalAbort);
  }
}
