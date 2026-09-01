import { describe, expect, test } from 'vitest';

describe('WebSocket Provider public entries', () => {
  test('keeps browser discovery isolated from server capabilities', async () => {
    const client = await import('../src/client.js');

    expect(Object.keys(client)).toEqual(['createWebSocketPeerDiscovery']);
  });

  test('exposes the runtime-neutral rendezvous hub from its own entry', async () => {
    const hub = await import('../src/hub.js');

    expect(Object.keys(hub).sort()).toEqual([
      'createWebSocketRendezvousHub',
      'webSocketRendezvousDefaultMaxPayloadBytes',
    ]);
  });

  test('keeps the existing rendezvous hub exports in the Node server entry', async () => {
    const server = await import('../src/server.js');

    expect(Object.keys(server).sort()).toEqual([
      'createWebSocketRendezvousHub',
      'createWebSocketRendezvousServer',
      'webSocketRendezvousDefaultMaxPayloadBytes',
    ]);
  });
});
