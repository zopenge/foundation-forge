import type { PeerAdvertisement } from '@openge/forge-peer-network';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createWebSocketPeerDiscovery } from '../src/client.js';
import { FakeWebSocket, localAdvertisement } from './fixtures.js';

describe('WebSocket peer discovery client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('registers and emits only valid remote advertisements', () => {
    const socket = new FakeWebSocket();
    const discovery = createWebSocketPeerDiscovery({
      advertisement: localAdvertisement,
      token: 'secret-token',
      url: 'ws://127.0.0.1/rendezvous',
      webSocketFactory: () => socket,
    });
    const received: (readonly PeerAdvertisement[])[] = [];
    discovery.onAdvertisements((advertisements) => received.push(advertisements));

    socket.open();
    socket.receive({
      advertisements: [
        localAdvertisement,
        {
          endpoint: {
            addresses: ['/ip4/127.0.0.1/tcp/4002'],
            peerId: 'remote-peer',
          },
          scopeId: 'scope-a',
        },
        { endpoint: null, scopeId: 'scope-a' },
      ],
      type: 'advertisements',
    });

    expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
      advertisement: localAdvertisement,
      token: 'secret-token',
      type: 'register',
    });
    expect(received).toEqual([[
      {
        endpoint: {
          addresses: ['/ip4/127.0.0.1/tcp/4002'],
          peerId: 'remote-peer',
        },
        scopeId: 'scope-a',
      },
    ]]);

    discovery.close();
  });

  test('publishes replacement advertisements on an open socket', () => {
    const socket = new FakeWebSocket();
    const discovery = createWebSocketPeerDiscovery({
      advertisement: localAdvertisement,
      token: 'secret-token',
      url: 'ws://127.0.0.1/rendezvous',
      webSocketFactory: () => socket,
    });
    socket.open();

    discovery.publish({
      endpoint: {
        addresses: ['/ip4/127.0.0.1/tcp/5001'],
        peerId: 'local-peer',
      },
      scopeId: 'scope-b',
    });

    expect(JSON.parse(socket.sent.at(-1) ?? '')).toMatchObject({
      advertisement: { scopeId: 'scope-b' },
      token: 'secret-token',
      type: 'register',
    });

    discovery.close();
  });

  test('heartbeats, reconnects, and stops idempotently', async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const discovery = createWebSocketPeerDiscovery({
      advertisement: localAdvertisement,
      heartbeatIntervalMs: 100,
      reconnectDelayMs: 50,
      token: 'secret-token',
      url: 'ws://127.0.0.1/rendezvous',
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]?.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? '')).toEqual({ type: 'ping' });

    sockets[0]?.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(JSON.parse(sockets[1]?.sent[0] ?? '')).toMatchObject({
      advertisement: localAdvertisement,
      type: 'register',
    });

    discovery.close();
    discovery.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
  });
});
