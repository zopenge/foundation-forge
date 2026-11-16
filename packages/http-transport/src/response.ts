import { addAbortSignal, pipeline, type Readable, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Dispatcher } from 'undici';
import { HttpTransportError, sanitizeHttpTransportError } from './errors.js';

function decodeBody(data: Dispatcher.ResponseData, headers: Headers): Readable {
  const encodings = headers.get('content-encoding')?.toLowerCase().split(',').map(value => value.trim()) ?? [];
  const decoders: Record<string, () => Transform> = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };
  if (encodings.some(value => !Object.hasOwn(decoders, value))) return data.body;
  if (encodings.length > 5) { data.body.on('error', () => {}); data.body.destroy(); throw new HttpTransportError('unknown'); }
  let source: Readable = data.body;
  for (const encoding of encodings.reverse()) {
    const factory = decoders[encoding];
    if (!factory) throw new HttpTransportError('unknown');
    const decoder = factory();
    pipeline(source, decoder, error => { if (error) decoder.destroy(error); });
    source = decoder;
  }
  if (encodings.length) { headers.delete('content-encoding'); headers.delete('content-length'); }
  return source;
}

function metadata(response: Response, url: string): Response {
  Object.defineProperties(response, {
    url: { value: url }, type: { value: 'basic' }, redirected: { value: false },
    clone: { value(this: Response) { return metadata(Response.prototype.clone.call(this), url); } },
  });
  return response;
}

export function createResponse(data: Dispatcher.ResponseData, url: string, method: string, signal: AbortSignal, release: () => void): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(data.headers)) {
    for (const entry of typeof value === 'string' ? [value] : value ?? []) headers.append(name, entry);
  }
  const noBody = method === 'HEAD' || [204, 205, 304].includes(data.statusCode);
  if (noBody) {
    data.body.on('error', () => {});
    data.body.once('close', release);
    data.body.destroy();
    return metadata(new Response(null, { status: data.statusCode, statusText: data.statusText, headers }), url);
  }
  const source = decodeBody(data, headers), iterator = source[Symbol.asyncIterator]();
  source.once('close', release);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 未读body也立即接收底层失败，避免error事件脱离资源所有者。
      source.on('error', error => controller.error(sanitizeHttpTransportError(error, signal)));
      if (signal) addAbortSignal(signal, source);
    },
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) { controller.error(sanitizeHttpTransportError(error, signal)); }
    },
    async cancel() {
      // 不向底层传播可能含凭据的调用方取消文本。
      try { source.destroy(); await iterator.return?.(); }
      catch (error) { throw sanitizeHttpTransportError(error, signal); }
    },
  }, { highWaterMark: 0 });
  const response = new Response(body, {
    status: data.statusCode, statusText: data.statusText, headers,
  });
  return metadata(response, url);
}
