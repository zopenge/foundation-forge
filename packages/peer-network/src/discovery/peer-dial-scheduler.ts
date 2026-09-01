import type {
  PeerAdvertisement,
  PeerConnection,
  PeerEndpoint,
  PeerNetwork,
} from '../network/contracts.js';

export type PeerDialSchedulerEvent =
  | {
      readonly endpoint: PeerEndpoint;
      readonly error: unknown;
      readonly type: 'attempt-failed';
    }
  | {
      readonly cleanupError?: unknown;
      readonly connection: PeerConnection;
      readonly endpoint: PeerEndpoint;
      readonly error: unknown;
      readonly type: 'setup-failed';
    }
  | {
      readonly connection: PeerConnection;
      readonly type: 'connected';
    };

export interface CreatePeerDialSchedulerOptions {
  readonly network: PeerNetwork;
  readonly onConnected?: (connection: PeerConnection) => void | Promise<void>;
  readonly retryDelaysMs?: readonly number[];
}

export interface PeerDialScheduler {
  close(): void;
  consider(advertisements: readonly PeerAdvertisement[]): void;
  onEvent(listener: (event: PeerDialSchedulerEvent) => void): () => void;
}

interface PeerDialState {
  readonly endpoint: PeerEndpoint;
  readonly startedAt: number;
  controller: AbortController | undefined;
  nextAttemptIndex: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export const createPeerDialScheduler = ({
  network,
  onConnected,
  retryDelaysMs = [0],
}: CreatePeerDialSchedulerOptions): PeerDialScheduler => {
  const connectedPeerIds = new Set<string>();
  const listeners = new Set<(event: PeerDialSchedulerEvent) => void>();
  const peerStates = new Map<string, PeerDialState>();
  let closed = false;
  const removeNetworkEventListener = network.onEvent((event) => {
    if (event.type === 'peer-disconnected') {
      connectedPeerIds.delete(event.peerId);
      const state = peerStates.get(event.peerId);
      if (state !== undefined) {
        peerStates.delete(event.peerId);
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
        }
        state.controller?.abort();
      }
    }
  });

  const emit = (event: PeerDialSchedulerEvent): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  const isCurrentState = (state: PeerDialState): boolean =>
    peerStates.get(state.endpoint.peerId) === state;

  const closeAfterFailedSetup = async (
    connection: PeerConnection,
  ): Promise<unknown | undefined> => {
    try {
      await connection.close();
      return undefined;
    } catch (error) {
      return error;
    }
  };

  const scheduleNext = (state: PeerDialState): void => {
    if (closed || !isCurrentState(state)) {
      return;
    }
    const targetDelayMs = retryDelaysMs[state.nextAttemptIndex];
    if (targetDelayMs === undefined) {
      peerStates.delete(state.endpoint.peerId);
      return;
    }
    state.nextAttemptIndex += 1;
    const remainingDelayMs = Math.max(0, state.startedAt + targetDelayMs - Date.now());
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void connect(state);
    }, remainingDelayMs);
  };

  const connect = async (state: PeerDialState): Promise<void> => {
    if (closed || !isCurrentState(state)) {
      return;
    }
    const controller = new AbortController();
    state.controller = controller;
    let connection: PeerConnection;
    try {
      connection = await network.connect(state.endpoint, {
        signal: controller.signal,
      });
    } catch (error) {
      if (!closed && !controller.signal.aborted) {
        emit({ endpoint: state.endpoint, error, type: 'attempt-failed' });
        scheduleNext(state);
      }
      if (state.controller === controller) {
        state.controller = undefined;
      }
      return;
    }

    if (closed || !isCurrentState(state)) {
      await closeAfterFailedSetup(connection);
      return;
    }

    try {
      await onConnected?.(connection);
    } catch (error) {
      const cleanupError = await closeAfterFailedSetup(connection);
      if (!closed && isCurrentState(state)) {
        emit({
          connection,
          endpoint: state.endpoint,
          error,
          ...(cleanupError === undefined ? {} : { cleanupError }),
          type: 'setup-failed',
        });
        scheduleNext(state);
      }
      if (state.controller === controller) {
        state.controller = undefined;
      }
      return;
    }

    if (closed || !isCurrentState(state)) {
      await closeAfterFailedSetup(connection);
      return;
    }
    connectedPeerIds.add(state.endpoint.peerId);
    peerStates.delete(state.endpoint.peerId);
    if (state.controller === controller) {
      state.controller = undefined;
    }
    emit({ connection, type: 'connected' });
  };

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      removeNetworkEventListener();
      for (const state of peerStates.values()) {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
        }
        state.controller?.abort();
      }
      peerStates.clear();
      listeners.clear();
    },
    consider: (advertisements) => {
      if (closed) {
        return;
      }
      for (const { endpoint } of advertisements) {
        if (
          endpoint.peerId === network.localPeerId
          || connectedPeerIds.has(endpoint.peerId)
          || peerStates.has(endpoint.peerId)
        ) {
          continue;
        }
        const state: PeerDialState = {
          controller: undefined,
          endpoint,
          nextAttemptIndex: 0,
          startedAt: Date.now(),
          timer: undefined,
        };
        peerStates.set(endpoint.peerId, state);
        scheduleNext(state);
      }
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
