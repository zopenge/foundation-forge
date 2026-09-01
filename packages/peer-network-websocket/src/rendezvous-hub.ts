import type { PeerAdvertisement } from '@openge/forge-peer-network';

import { parseWebSocketRendezvousClientMessage } from './protocol.js';

export interface WebSocketRendezvousConnection {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export interface WebSocketRendezvousRegistrationAuthorization<TContext> {
  readonly advertisement: PeerAdvertisement;
  readonly context: TContext;
  readonly token: string;
}

export interface WebSocketRendezvousDiagnostic {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CreateWebSocketRendezvousHubOptions<TContext> {
  readonly authorizeRegistration: (
    request: WebSocketRendezvousRegistrationAuthorization<TContext>,
  ) => boolean | Promise<boolean>;
  readonly maxMessagesPerWindow?: number;
  readonly maxPayloadBytes?: number;
  readonly maxPeersPerScope?: number;
  readonly maxScopes?: number;
  readonly messageWindowMs?: number;
  readonly onDiagnostic?: (event: WebSocketRendezvousDiagnostic) => void;
  readonly sweepIntervalMs?: number | false;
  readonly ttlMs?: number;
}

export interface WebSocketRendezvousSession {
  close(): void;
  receive(data: string): Promise<void>;
}

export interface WebSocketRendezvousHub<TContext> {
  close(): void;
  openSession(
    connection: WebSocketRendezvousConnection,
    context: TContext,
  ): WebSocketRendezvousSession;
}

interface RendezvousSessionState<TContext> {
  readonly connection: WebSocketRendezvousConnection;
  readonly context: TContext;
  closed: boolean;
  messageCount: number;
  registeredAdvertisement: PeerAdvertisement | undefined;
  timestamp: number;
  windowStartedAt: number;
}

export const webSocketRendezvousDefaultMaxPayloadBytes = 16_384;

export const createWebSocketRendezvousHub = <TContext = undefined>({
  authorizeRegistration,
  maxMessagesPerWindow = 40,
  maxPayloadBytes = webSocketRendezvousDefaultMaxPayloadBytes,
  maxPeersPerScope = 2_000,
  maxScopes = 200,
  messageWindowMs = 10_000,
  onDiagnostic,
  sweepIntervalMs = 10_000,
  ttlMs = 30_000,
}: CreateWebSocketRendezvousHubOptions<TContext>): WebSocketRendezvousHub<TContext> => {
  const scopes = new Map<string, Map<string, RendezvousSessionState<TContext>>>();
  const sessions = new Set<RendezvousSessionState<TContext>>();
  const encoder = new TextEncoder();
  let closed = false;

  const emitDiagnostic = (
    code: string,
    details?: Readonly<Record<string, unknown>>,
  ): void => {
    onDiagnostic?.(details === undefined ? { code } : { code, details });
  };

  const broadcastScope = (scopeId: string): void => {
    const peers = scopes.get(scopeId);
    if (peers === undefined) {
      return;
    }
    const payload = JSON.stringify({
      advertisements: [...peers.values()].flatMap((session) => (
        session.registeredAdvertisement === undefined
          ? []
          : [session.registeredAdvertisement]
      )),
      type: 'advertisements',
    });
    for (const session of [...peers.values()]) {
      if (session.closed) {
        continue;
      }
      try {
        session.connection.send(payload);
      } catch (error) {
        emitDiagnostic('send-error', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const removeRegistration = (session: RendezvousSessionState<TContext>): void => {
    const advertisement = session.registeredAdvertisement;
    session.registeredAdvertisement = undefined;
    if (advertisement === undefined) {
      return;
    }
    const peers = scopes.get(advertisement.scopeId);
    if (peers?.get(advertisement.endpoint.peerId) !== session) {
      return;
    }
    peers.delete(advertisement.endpoint.peerId);
    if (peers.size === 0) {
      scopes.delete(advertisement.scopeId);
      return;
    }
    broadcastScope(advertisement.scopeId);
  };

  const closeSession = (
    session: RendezvousSessionState<TContext>,
    closeConnection: boolean,
    code?: number,
    reason?: string,
  ): void => {
    if (session.closed) {
      return;
    }
    session.closed = true;
    sessions.delete(session);
    removeRegistration(session);
    if (closeConnection) {
      session.connection.close(code, reason);
    }
  };

  const ensureScope = (
    scopeId: string,
  ): Map<string, RendezvousSessionState<TContext>> | undefined => {
    const existing = scopes.get(scopeId);
    if (existing !== undefined) {
      return existing;
    }
    if (scopes.size >= maxScopes) {
      return undefined;
    }
    const created = new Map<string, RendezvousSessionState<TContext>>();
    scopes.set(scopeId, created);
    return created;
  };

  const rejectSession = (
    session: RendezvousSessionState<TContext>,
    diagnosticCode: string,
    closeCode: number,
    reason: string,
  ): void => {
    emitDiagnostic(diagnosticCode);
    closeSession(session, true, closeCode, reason);
  };

  const processMessage = async (
    session: RendezvousSessionState<TContext>,
    data: string,
  ): Promise<void> => {
    if (closed || session.closed) {
      return;
    }
    const now = Date.now();
    if (now - session.timestamp > ttlMs) {
      closeSession(session, true, 1001, 'registration-expired');
      return;
    }
    if (now - session.windowStartedAt > messageWindowMs) {
      session.windowStartedAt = now;
      session.messageCount = 0;
    }
    session.messageCount += 1;
    if (session.messageCount > maxMessagesPerWindow) {
      rejectSession(session, 'rate-limit', 1011, 'rate-limit');
      return;
    }
    if (encoder.encode(data).byteLength > maxPayloadBytes) {
      rejectSession(session, 'message-too-large', 1009, 'message-too-large');
      return;
    }
    const message = parseWebSocketRendezvousClientMessage(data);
    if (message === undefined) {
      rejectSession(session, 'invalid-message', 1008, 'invalid-message');
      return;
    }
    if (message.type === 'ping') {
      if (session.registeredAdvertisement === undefined) {
        rejectSession(session, 'unregistered-heartbeat', 1008, 'invalid-message');
        return;
      }
      session.timestamp = now;
      return;
    }

    let authorized: boolean;
    try {
      authorized = await authorizeRegistration({
        advertisement: message.advertisement,
        context: session.context,
        token: message.token,
      });
    } catch (error) {
      emitDiagnostic('authorization-error', {
        reason: error instanceof Error ? error.message : String(error),
      });
      closeSession(session, true, 1011, 'authorization-error');
      return;
    }
    if (closed || session.closed) {
      return;
    }
    if (!authorized) {
      rejectSession(session, 'unauthorized-registration', 1008, 'invalid-token');
      return;
    }

    removeRegistration(session);
    const { advertisement } = message;
    const peers = ensureScope(advertisement.scopeId);
    if (peers === undefined) {
      rejectSession(session, 'scope-limit', 1013, 'scope-limit');
      return;
    }
    const existing = peers.get(advertisement.endpoint.peerId);
    if (existing === undefined && peers.size >= maxPeersPerScope) {
      rejectSession(session, 'scope-full', 1013, 'scope-full');
      return;
    }
    session.registeredAdvertisement = advertisement;
    session.timestamp = now;
    peers.set(advertisement.endpoint.peerId, session);
    if (existing !== undefined && existing !== session) {
      closeSession(existing, true, 1008, 'peer-replaced');
    }
    broadcastScope(advertisement.scopeId);
  };

  const sweepTimer = sweepIntervalMs === false
    ? undefined
    : setInterval(() => {
      const now = Date.now();
      for (const session of [...sessions]) {
        if (now - session.timestamp > ttlMs) {
          closeSession(session, true, 1001, 'registration-expired');
        }
      }
    }, sweepIntervalMs);
  if (typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    sweepTimer.unref();
  }

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
      }
      for (const session of [...sessions]) {
        closeSession(session, true, 1001, 'server-shutdown');
      }
      scopes.clear();
    },
    openSession: (connection, context) => {
      const now = Date.now();
      const session = {
        closed,
        connection,
        context,
        messageCount: 0,
        registeredAdvertisement: undefined,
        timestamp: now,
        windowStartedAt: now,
      } satisfies RendezvousSessionState<TContext>;
      if (closed) {
        connection.close(1001, 'server-shutdown');
      } else {
        sessions.add(session);
      }
      let receiveQueue = Promise.resolve();

      return {
        close: () => closeSession(session, false),
        receive: (data) => {
          receiveQueue = receiveQueue.then(async () => processMessage(session, data));
          return receiveQueue;
        },
      };
    },
  };
};
