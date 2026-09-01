import { PeerNetworkError, type PeerNetworkErrorCode } from './errors.js';

const maxTimeoutMs = 2_147_483_647;

export interface RunPeerNetworkOperationOptions<Result> {
  readonly operation: (signal: AbortSignal) => Promise<Result>;
  readonly signal?: AbortSignal;
  readonly timeoutCode: PeerNetworkErrorCode;
  readonly timeoutMs?: number;
}

export const runPeerNetworkOperation = async <Result>({
  operation,
  signal,
  timeoutCode,
  timeoutMs,
}: RunPeerNetworkOperationOptions<Result>): Promise<Result> => {
  signal?.throwIfAborted();

  if (timeoutMs === undefined) {
    return operation(signal ?? new AbortController().signal);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs must be a non-negative finite number');
  }
  if (timeoutMs > maxTimeoutMs) {
    throw new RangeError(
      `timeoutMs must not exceed ${maxTimeoutMs} (Node.js setTimeout limit)`,
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => {
    controller.abort(signal?.reason);
  };
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(timeoutCode, 'TimeoutError'));
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut && signal?.aborted !== true) {
      throw new PeerNetworkError(timeoutCode, { timeoutMs }, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
};
