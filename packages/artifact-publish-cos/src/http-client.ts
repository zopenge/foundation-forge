import { Buffer } from 'node:buffer';
import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { ArtifactPublicationError, type ArtifactRequestContext, type ArtifactTransportClosure } from '@openge/forge-artifact-publish';
import type { CosConfiguration } from './configuration.js';
import { signCosRequest, type CosRequest } from './cos-signing.js';
import { cosStatusError, cosXmlLimit } from './http-status.js';

export interface CosResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface OwnedRequest { readonly request: ClientRequest; readonly closed: Promise<void>; readonly cancel: () => void }

export class CosHttpClient {
  readonly #configuration: CosConfiguration;
  readonly #agent: HttpAgent;
  readonly #requests = new Set<OwnedRequest>();
  readonly #sockets = new Map<Socket, Promise<void>>();
  #closed = false;
  #closing: Promise<ArtifactTransportClosure> | undefined;

  constructor(configuration: CosConfiguration) {
    this.#configuration = configuration;
    this.#agent = configuration.endpoint.protocol === 'https:'
      ? new HttpsAgent({ keepAlive: false, maxSockets: 64, maxTotalSockets: 64 })
      : new HttpAgent({ keepAlive: false, maxSockets: 64, maxTotalSockets: 64 });
  }

  async request(input: CosRequest, context: ArtifactRequestContext): Promise<CosResponse> {
    this.assertOpen();
    if (context.signal.aborted) throw new ArtifactPublicationError('OPERATION_ABORTED');
    const deadline = performance.now() + context.timeoutMilliseconds;
    const remainingMilliseconds = () => Math.min(context.timeoutMilliseconds, Math.ceil(deadline - performance.now()));
    const signed = signCosRequest(this.#configuration, input, context);
    // 同步签名和摘要准备也占用请求预算，耗尽后不能再建立连接。
    if (remainingMilliseconds() <= 0) throw new ArtifactPublicationError('BUDGET_EXCEEDED');
    if (context.signal.aborted) throw new ArtifactPublicationError('OPERATION_ABORTED');
    const request = signed.url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<CosResponse>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      let responseDone = false;
      let requestClosed = false;
      let failure: ArtifactPublicationError | undefined;
      let result: CosResponse | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let owned: OwnedRequest | undefined;
      let resolveClosed: (() => void) | undefined;
      const closed = new Promise<void>(done => { resolveClosed = done; });
      let outgoing: ClientRequest;
      const finish = () => {
        if (!requestClosed || (!responseDone && !failure)) return;
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
        if (owned) this.#requests.delete(owned);
        resolveClosed?.();
        if (failure) reject(failure);
        else if (result) resolve(result);
        else reject(new ArtifactPublicationError('TRANSPORT_FAILED'));
      };
      const fail = (error: ArtifactPublicationError) => {
        failure ??= error;
        response?.destroy();
        outgoing.destroy();
        finish();
      };
      const onAbort = () => { fail(new ArtifactPublicationError('OPERATION_ABORTED')); };
      try {
        outgoing = request(signed.url, { method: input.method, headers: signed.headers, agent: this.#agent }, incoming => {
          response = incoming;
          const chunks: Buffer[] = [];
          let length = 0;
          const statusCode = incoming.statusCode;
          const responseLimit = statusCode === 409 ? cosXmlLimit : input.maxResponseBytes;
          const declaredLength = incoming.headers['content-length'];
          incoming.on('data', (chunk: Buffer) => {
            if (failure) return;
            length += chunk.byteLength;
            if (length > responseLimit) { fail(new ArtifactPublicationError('RESPONSE_TOO_LARGE')); return; }
            chunks.push(chunk);
          });
          incoming.once('aborted', () => { fail(new ArtifactPublicationError('TRANSPORT_FAILED')); });
          incoming.once('error', () => { fail(new ArtifactPublicationError('TRANSPORT_FAILED')); });
          incoming.once('end', () => {
            responseDone = true;
            if (!incoming.complete || statusCode === undefined || statusCode < 100 || statusCode > 599) {
              fail(new ArtifactPublicationError('INVALID_REMOTE_RESPONSE'));
            } else {
              result = { statusCode, headers: incoming.headers, body: Buffer.concat(chunks, length) };
              finish();
            }
          });
          incoming.once('close', () => {
            if (!responseDone && !failure) fail(new ArtifactPublicationError('TRANSPORT_FAILED'));
            finish();
          });
          if (statusCode === undefined || statusCode < 100 || statusCode > 599) fail(new ArtifactPublicationError('INVALID_REMOTE_RESPONSE'));
          else if (statusCode !== 200 && statusCode !== 409) fail(cosStatusError(statusCode));
          else if (declaredLength !== undefined && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > responseLimit)) {
            fail(new ArtifactPublicationError('RESPONSE_TOO_LARGE'));
          }
        });
        owned = { request: outgoing, closed, cancel: () => { fail(new ArtifactPublicationError('TRANSPORT_CLOSED')); } };
        this.#requests.add(owned);
        outgoing.once('socket', socket => {
          const socketClosed = new Promise<void>(done => {
            socket.once('close', () => { this.#sockets.delete(socket); done(); });
          });
          this.#sockets.set(socket, socketClosed);
          if (this.#closed) socket.destroy();
        });
        outgoing.once('error', () => { fail(new ArtifactPublicationError(this.#closed ? 'TRANSPORT_CLOSED' : 'TRANSPORT_FAILED')); });
        outgoing.once('close', () => {
          requestClosed = true;
          if (!response && !failure) failure = new ArtifactPublicationError('TRANSPORT_FAILED');
          finish();
        });
        context.signal.addEventListener('abort', onAbort, { once: true });
        const remaining = remainingMilliseconds();
        if (context.signal.aborted) onAbort();
        else if (remaining <= 0) fail(new ArtifactPublicationError('BUDGET_EXCEEDED'));
        else {
          timer = setTimeout(() => { fail(new ArtifactPublicationError('BUDGET_EXCEEDED')); }, remaining);
          outgoing.end(signed.body);
        }
      } catch {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
        if (owned) owned.request.destroy();
        else { resolveClosed?.(); reject(new ArtifactPublicationError('TRANSPORT_FAILED')); }
      }
    });
  }

  assertOpen(): void { if (this.#closed) throw new ArtifactPublicationError('TRANSPORT_CLOSED'); }

  close(timeoutMilliseconds: number): Promise<ArtifactTransportClosure> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#finishClose(timeoutMilliseconds);
    return this.#closing;
  }

  async #finishClose(timeoutMilliseconds: number): Promise<ArtifactTransportClosure> {
    for (const owned of this.#requests) owned.cancel();
    this.#agent.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      const timeout = new Promise<void>(done => {
        timer = setTimeout(() => { expired = true; done(); }, timeoutMilliseconds);
      });
      while (!expired && (this.#requests.size > 0 || this.#sockets.size > 0)) {
        await Promise.race([
          Promise.all([...this.#requests].map(value => value.closed).concat([...this.#sockets.values()])), timeout,
        ]);
      }
    } finally { clearTimeout(timer); }
    return {
      status: this.#requests.size === 0 && this.#sockets.size === 0 ? 'closed' : 'unconfirmed',
      activeRequests: this.#requests.size,
    };
  }
}
