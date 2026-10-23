import type { ArtifactPublicationTransport, ArtifactTransportClosure } from './contracts.js';
import { ArtifactPublicationError } from './errors.js';

const ownership = new WeakMap<ArtifactPublicationTransport, 'active' | 'consumed'>();

export function claimTransport(transport: ArtifactPublicationTransport): void {
  if (!transport || typeof transport !== 'object') throw new ArtifactPublicationError('INVALID_TARGET');
  const state = ownership.get(transport);
  if (state) throw new ArtifactPublicationError(state === 'active' ? 'TRANSPORT_IN_USE' : 'TRANSPORT_CLOSED');
  ownership.set(transport, 'active');
}

export function finishTransportUse(transport: ArtifactPublicationTransport): void {
  ownership.set(transport, 'consumed');
}

export async function closeTransport(transport: ArtifactPublicationTransport, timeoutMilliseconds: number,
  pendingRequests: () => number, settleRequests: () => Promise<void>): Promise<ArtifactTransportClosure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let value: unknown;
  try {
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => { resolve(undefined); }, timeoutMilliseconds); });
    value = await Promise.race([
      Promise.resolve().then(() => transport.close({ timeoutMilliseconds })).catch(() => undefined),
      deadline,
    ]);
    if (pendingRequests() > 0) await Promise.race([settleRequests(), deadline]);
  } finally { clearTimeout(timer); }
  const pending = pendingRequests();
  if (!value || typeof value !== 'object' || !('activeRequests' in value) || !('status' in value)
    || (value.activeRequests !== null && (typeof value.activeRequests !== 'number' || !Number.isSafeInteger(value.activeRequests) || value.activeRequests < 0))) {
    return { status: 'unconfirmed', activeRequests: null };
  }
  const activeRequests = value.activeRequests === null ? null : Math.max(pending, value.activeRequests);
  return { status: value.status === 'closed' && activeRequests === 0 ? 'closed' : 'unconfirmed', activeRequests };
}
