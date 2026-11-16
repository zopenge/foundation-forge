import type { NodeHttpTransportOptions } from '@openge/forge-http-transport';
import { createNodeHttpTransport } from '@openge/forge-http-transport/node';
import { ReleaseError } from './errors.js';

export async function readBuildInfo(url: string, signal: AbortSignal, maxBytes: number,
  options: NodeHttpTransportOptions = { route: 'direct' }): Promise<unknown> {
  const client = createNodeHttpTransport(options);
  try {
    const response = await client.fetch(url, { method: 'GET', signal, credentials: 'omit', cache: 'no-store',
      headers: { 'cache-control': 'no-cache', accept: 'application/json' } });
    if (!response.ok || !response.body) throw new ReleaseError('BUILD_INFO', { status: response.status });
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maxBytes) throw new ReleaseError('BUILD_INFO', { reason: 'OUTPUT_LIMIT' });
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new ReleaseError('BUILD_INFO', { reason: 'INVALID_JSON' }); }
  } finally { await client.close(); }
}
