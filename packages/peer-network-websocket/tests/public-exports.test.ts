import { describe, expect, test } from 'vitest';

describe('WebSocket Provider public entries', () => {
  test('keeps browser discovery isolated from server capabilities', async () => {
    const client = await import('../src/client.js');

    expect(Object.keys(client)).toEqual(['createWebSocketPeerDiscovery']);
  });

  test('exposes the rendezvous hub and Node server only from the server entry', async () => {
    const server = await import('../src/server.js');

    expect(Object.keys(server).sort()).toEqual([
      'createWebSocketRendezvousHub',
      'createWebSocketRendezvousServer',
      'webSocketRendezvousDefaultMaxPayloadBytes',
    ]);
  });
});
