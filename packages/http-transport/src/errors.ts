import type { HttpTransportErrorCategory, HttpTransportErrorClassification } from './contracts.js';

const retryableCategories = new Set<HttpTransportErrorCategory>(['dns', 'timeout', 'connection', 'proxy-connect']);
const classification = (category: HttpTransportErrorCategory): HttpTransportErrorClassification =>
  Object.freeze({ category, retryable: retryableCategories.has(category) });

export class HttpTransportError extends Error {
  readonly classification: HttpTransportErrorClassification;

  constructor(category: HttpTransportErrorCategory) {
    super(`HTTP_TRANSPORT_${category.toUpperCase().replaceAll('-', '_')}`);
    this.name = 'HttpTransportError';
    this.classification = classification(category);
  }
}

const field = (value: object, key: string): unknown => {
  try { return Reflect.get(value, key); } catch { return undefined; }
};

const certificateCodes = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'INVALID_CA', 'CERT_UNTRUSTED', 'CERT_REJECTED',
]);

function ownCategory(error: object): HttpTransportErrorCategory | undefined {
  const code = field(error, 'code'), name = field(error, 'name');
  // 只识别所锁定 Undici 的固定 CONNECT 错误，不回传或保留原始文本。
  if (code === 'UND_ERR_ABORTED') {
    const message = field(error, 'message');
    const status = typeof message === 'string' ? /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/u.exec(message)?.[1] : undefined;
    if (status) return status === '407' ? 'proxy-auth' : 'proxy-connect';
  }
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') return 'cancelled';
  if (name === 'TimeoutError') return 'timeout';
  if (typeof code !== 'string') return undefined;
  if (certificateCodes.has(code)) return 'certificate';
  if (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) return 'tls';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) return 'connection';
  return undefined;
}

export function classifyHttpTransportError(error: unknown): HttpTransportErrorClassification {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): HttpTransportErrorCategory => {
    if (typeof value !== 'object' || value === null || depth > 16 || seen.has(value)) return 'unknown';
    seen.add(value);
    if (value instanceof HttpTransportError) return value.classification.category;
    const own = ownCategory(value);
    if (own) return own;
    const errors = field(value, 'errors');
    if (Array.isArray(errors)) {
      if (errors.length === 0 || errors.length > 32) return 'unknown';
      const categories = errors.map(item => visit(item, depth + 1));
      for (const blocked of ['certificate', 'tls', 'proxy-auth', 'cancelled', 'unknown'] as const) {
        if (categories.includes(blocked)) return blocked;
      }
      return categories[0] ?? 'unknown';
    }
    return visit(field(value, 'cause'), depth + 1);
  };
  return classification(visit(error, 0));
}

export function sanitizeHttpTransportError(error: unknown, signal?: AbortSignal | null): HttpTransportError {
  if (signal?.aborted) {
    const reason = classifyHttpTransportError(signal.reason);
    return new HttpTransportError(reason.category === 'timeout' ? 'timeout' : 'cancelled');
  }
  return new HttpTransportError(classifyHttpTransportError(error).category);
}
