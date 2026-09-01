import type {
  PeerAdvertisement,
  PeerDiscovery,
  PeerDiscoveryListener,
} from '@openge/forge-peer-network';

import { parseWebSocketRendezvousAdvertisements } from './protocol.js';

export interface WebSocketPeerDiscoverySocket {
  readonly readyState?: number;
  close(): void;
  onclose: ((event: Event) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onopen: ((event: Event) => unknown) | null;
  send(data: string): void;
}

export interface CreateWebSocketPeerDiscoveryOptions {
  readonly advertisement: PeerAdvertisement;
  readonly heartbeatIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly token: string;
  readonly url: string;
  readonly webSocketFactory: (url: string) => WebSocketPeerDiscoverySocket;
}

const openReadyState = 1;

export const createWebSocketPeerDiscovery = ({
  advertisement: initialAdvertisement,
  heartbeatIntervalMs = 8_000,
  reconnectDelayMs = 500,
  token,
  url,
  webSocketFactory,
}: CreateWebSocketPeerDiscoveryOptions): PeerDiscovery => {
  const listeners = new Set<PeerDiscoveryListener>();
  let socket: WebSocketPeerDiscoverySocket | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let advertisement = initialAdvertisement;
  let closed = false;

  const clearTimers = (): void => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const sendRegistration = (): void => {
    if (closed || socket?.readyState !== openReadyState) {
      return;
    }
    socket.send(JSON.stringify({
      advertisement,
      token,
      type: 'register',
    }));
  };

  const openSocket = (): void => {
    if (closed) {
      return;
    }
    const nextSocket = webSocketFactory(url);
    socket = nextSocket;
    nextSocket.onopen = () => {
      sendRegistration();
      heartbeatTimer = setInterval(() => {
        if (!closed && nextSocket.readyState === openReadyState) {
          nextSocket.send(JSON.stringify({ type: 'ping' }));
        }
      }, heartbeatIntervalMs);
    };
    nextSocket.onmessage = (event) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data)) as unknown;
      } catch {
        return;
      }
      const advertisements = parseWebSocketRendezvousAdvertisements(value);
      if (advertisements === undefined) {
        return;
      }
      const peers = advertisements.filter(
        (candidate) => candidate.endpoint.peerId !== advertisement.endpoint.peerId,
      );
      for (const listener of [...listeners]) {
        listener(peers);
      }
    };
    nextSocket.onclose = () => {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (!closed) {
        reconnectTimer = setTimeout(openSocket, reconnectDelayMs);
      }
    };
  };

  openSocket();

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimers();
      listeners.clear();
      if (socket !== undefined) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
      }
      socket = undefined;
    },
    onAdvertisements: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (nextAdvertisement) => {
      advertisement = nextAdvertisement;
      sendRegistration();
    },
  };
};
