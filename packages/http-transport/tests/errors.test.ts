import { describe, expect, it } from 'vitest';
import { classifyHttpTransportError } from '../src/index.js';

describe('HTTP transport classification', () => {
  it.each([
    ['ENOTFOUND', 'dns', true], ['EAI_AGAIN', 'dns', true],
    ['ETIMEDOUT', 'timeout', true], ['UND_ERR_CONNECT_TIMEOUT', 'timeout', true],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout', true], ['UND_ERR_BODY_TIMEOUT', 'timeout', true],
    ['ECONNREFUSED', 'connection', true], ['ECONNRESET', 'connection', true],
    ['EPIPE', 'connection', true], ['UND_ERR_SOCKET', 'connection', true],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate', false],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate', false],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate', false],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificate', false], ['CERT_HAS_EXPIRED', 'certificate', false],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls', false], ['ERR_TLS_HANDSHAKE_TIMEOUT', 'tls', false],
    ['ABORT_ERR', 'cancelled', false], ['SOMETHING_ELSE', 'unknown', false],
  ])('classifies %s without copying sensitive cause fields', (code, category, retryable) => {
    const cause = Object.assign(new Error('secret-password token ?query body'), { code, headers: 'secret-header' });
    expect(classifyHttpTransportError(new TypeError('fetch failed', { cause }))).toEqual({ category, retryable });
  });

  it('recognizes abort and timeout names and fixed CONNECT status errors', () => {
    expect(classifyHttpTransportError(new DOMException('secret', 'AbortError'))).toEqual({ category: 'cancelled', retryable: false });
    expect(classifyHttpTransportError(new DOMException('secret', 'TimeoutError'))).toEqual({ category: 'timeout', retryable: true });
    expect(classifyHttpTransportError({ code: 'UND_ERR_ABORTED', message: 'Proxy response (407) !== 200 when HTTP Tunneling' })).toEqual({ category: 'proxy-auth', retryable: false });
    expect(classifyHttpTransportError({ code: 'UND_ERR_ABORTED', message: 'Proxy response (401) !== 200 when HTTP Tunneling' })).toEqual({ category: 'proxy-auth', retryable: false });
    expect(classifyHttpTransportError({ code: 'UND_ERR_ABORTED', message: 'Proxy response (403) !== 200 when HTTP Tunneling' })).toEqual({ category: 'proxy-auth', retryable: false });
    expect(classifyHttpTransportError({ code: 'UND_ERR_ABORTED', message: 'Proxy response (502) !== 200 when HTTP Tunneling' })).toEqual({ category: 'proxy-connect', retryable: true });
  });

  it('does not promote arbitrary messages or unknown aggregate members into retryable connection failures', () => {
    expect(classifyHttpTransportError(new Error('ECONNRESET proxy 407 certificate'))).toEqual({ category: 'unknown', retryable: false });
    expect(classifyHttpTransportError(new AggregateError([{ code: 'ECONNRESET' }, new Error('unknown')]))).toEqual({ category: 'unknown', retryable: false });
    expect(classifyHttpTransportError(new AggregateError([{ code: 'ECONNREFUSED' }, { code: 'CERT_HAS_EXPIRED' }]))).toEqual({ category: 'certificate', retryable: false });
  });

  it('handles cyclic and untrusted error graphs conservatively', () => {
    const cycle: { cause?: object } = {};
    cycle.cause = cycle;
    for (const value of [undefined, null, 123, 'secret', cycle, { get code() { throw new Error('secret'); } }]) {
      expect(classifyHttpTransportError(value)).toEqual({ category: 'unknown', retryable: false });
    }
  });
});
