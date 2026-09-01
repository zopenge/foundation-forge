import { once } from 'node:events';

import type { PeerAdvertisement } from '@openge/forge-peer-network';
import { afterEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import {
  createWebSocketRendezvousServer,
  type WebSocketRendezvousServer,
} from '../src/server.js';
import { localAdvertisement, remoteAdvertisement } from './fixtures.js';

const openClient = async (url: string): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  return socket;
};

const waitForAdvertisementCount = async (
  socket: WebSocket,
  count: number,
): Promise<readonly PeerAdvertisement[]> => {
  while (true) {
    const [data] = await once(socket, 'message');
    const value = JSON.parse(String(data)) as {
      readonly advertisements?: readonly PeerAdvertisement[];
    };
    if (value.advertisements?.length === count) {
      return value.advertisements;
    }
  }
};

describe('WebSocket rendezvous Node server', () => {
  const servers: WebSocketRendezvousServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    await Promise.all(servers.splice(0).map(async (server) => server.close()));
  });

  test('rejects an empty token before opening a listener', async () => {
    await expect(createWebSocketRendezvousServer({
      port: 0,
      token: '',
    })).rejects.toThrow('rendezvous token is required');
  });

  test('registers and broadcasts scoped advertisements', async () => {
    const server = await createWebSocketRendezvousServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    servers.push(server);
    const first = await openClient(server.url);
    const second = await openClient(server.url);
    sockets.push(first, second);

    first.send(JSON.stringify({
      advertisement: localAdvertisement,
      token: 'secret',
      type: 'register',
    }));
    await waitForAdvertisementCount(first, 1);
    const firstUpdate = waitForAdvertisementCount(first, 2);
    const secondUpdate = waitForAdvertisementCount(second, 2);
    second.send(JSON.stringify({
      advertisement: remoteAdvertisement,
      token: 'secret',
      type: 'register',
    }));

    await expect(firstUpdate).resolves.toEqual([localAdvertisement, remoteAdvertisement]);
    await expect(secondUpdate).resolves.toEqual([localAdvertisement, remoteAdvertisement]);
  });

  test('rejects an invalid token and closes idempotently', async () => {
    const server = await createWebSocketRendezvousServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    servers.push(server);
    const socket = await openClient(server.url);
    sockets.push(socket);
    socket.send(JSON.stringify({
      advertisement: localAdvertisement,
      token: 'wrong',
      type: 'register',
    }));

    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
