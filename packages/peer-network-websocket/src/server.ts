import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import {
  createWebSocketRendezvousHub,
  webSocketRendezvousDefaultMaxPayloadBytes,
  type WebSocketRendezvousDiagnostic,
} from './rendezvous-hub.js';

export {
  createWebSocketRendezvousHub,
  webSocketRendezvousDefaultMaxPayloadBytes,
  type CreateWebSocketRendezvousHubOptions,
  type WebSocketRendezvousConnection,
  type WebSocketRendezvousDiagnostic,
  type WebSocketRendezvousHub,
  type WebSocketRendezvousRegistrationAuthorization,
  type WebSocketRendezvousSession,
} from './rendezvous-hub.js';

export interface CreateWebSocketRendezvousServerOptions {
  readonly host?: string;
  readonly maxMessagesPerWindow?: number;
  readonly maxPayloadBytes?: number;
  readonly maxPeersPerScope?: number;
  readonly maxScopes?: number;
  readonly messageWindowMs?: number;
  readonly onDiagnostic?: (event: WebSocketRendezvousDiagnostic) => void;
  readonly path?: string;
  readonly port: number;
  readonly sweepIntervalMs?: number | false;
  readonly token: string;
  readonly ttlMs?: number;
}

export interface WebSocketRendezvousServer {
  readonly host: string;
  readonly path: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const formatUrlHost = (host: string): string => host.includes(':') ? `[${host}]` : host;

export const createWebSocketRendezvousServer = async ({
  host = '0.0.0.0',
  maxMessagesPerWindow = 40,
  maxPayloadBytes = webSocketRendezvousDefaultMaxPayloadBytes,
  maxPeersPerScope = 2_000,
  maxScopes = 200,
  messageWindowMs = 10_000,
  onDiagnostic,
  path = '/',
  port,
  sweepIntervalMs = 10_000,
  token,
  ttlMs = 30_000,
}: CreateWebSocketRendezvousServerOptions): Promise<WebSocketRendezvousServer> => {
  if (token.length === 0) {
    throw new Error('rendezvous token is required');
  }
  const server = new WebSocketServer({
    host,
    maxPayload: maxPayloadBytes,
    path,
    perMessageDeflate: false,
    port,
  });
  const hub = createWebSocketRendezvousHub({
    authorizeRegistration: ({ token: registrationToken }) => registrationToken === token,
    maxMessagesPerWindow,
    maxPayloadBytes,
    maxPeersPerScope,
    maxScopes,
    messageWindowMs,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    sweepIntervalMs,
    ttlMs,
  });
  let closed = false;

  server.on('connection', (socket) => {
    const session = hub.openSession({
      close: (code, reason) => socket.close(code, reason),
      send: (data) => socket.send(data),
    }, undefined);

    socket.on('message', (data) => {
      void session.receive(data.toString());
    });
    socket.on('close', () => {
      session.close();
    });
  });
  server.on('error', (error) => {
    onDiagnostic?.({
      code: 'server-error',
      details: { reason: error.message },
    });
  });

  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    host,
    path,
    port: address.port,
    url: `ws://${formatUrlHost(host)}:${address.port}${path}`,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      hub.close();
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
};
