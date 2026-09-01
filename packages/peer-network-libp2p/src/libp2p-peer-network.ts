import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import {
  PeerNetworkError,
  createLengthPrefixedFrameCodec,
  runPeerNetworkOperation,
  type ClosePeerNetworkOptions,
  type PeerChannelCloseListener,
  type PeerConnection,
  type PeerConnectionListener,
  type PeerMessageChannel,
  type PeerMessageListener,
  type PeerNetwork,
  type PeerNetworkEvent,
  type PeerNetworkEventListener,
  type PeerProtocolChannelListener,
  type SendPeerMessageOptions,
} from '@openge/forge-peer-network';
import type { Libp2p } from 'libp2p';

interface CreateLibp2pPeerNetworkOptions {
  readonly maxMessageBytes?: number;
  readonly node: Libp2p;
}

interface ProtocolRegistrationState {
  installation: Promise<void>;
  readonly listeners: Set<PeerProtocolChannelListener>;
}

const defaultMaxMessageBytes = 32 * 1024 * 1024;

const toBytes = (
  chunk: Uint8Array | { subarray(): Uint8Array },
): Uint8Array => chunk instanceof Uint8Array ? chunk : chunk.subarray();

const getErrorDetails = (error: unknown): Readonly<Record<string, unknown>> => ({
  reason: error instanceof Error ? error.message : String(error),
});

const createLibp2pMessageChannel = (
  stream: Stream,
  protocolId: string,
  maxMessageBytes: number,
  onDiagnostic: (details: Readonly<Record<string, unknown>>) => void,
): PeerMessageChannel => {
  const closeListeners = new Set<PeerChannelCloseListener>();
  const listeners = new Set<PeerMessageListener>();
  const codec = createLengthPrefixedFrameCodec({ maxMessageBytes });
  let state: PeerMessageChannel['state'] = 'open';
  let reading: Promise<void> | undefined;

  const notifyClosed = (): void => {
    if (state === 'closed') {
      return;
    }
    state = 'closed';
    listeners.clear();
    for (const listener of [...closeListeners]) {
      listener();
    }
    closeListeners.clear();
  };

  stream.addEventListener('close', notifyClosed, { once: true });

  const startReading = (): void => {
    reading ??= (async () => {
      try {
        for await (const chunk of stream) {
          for (const message of codec.decode(toBytes(chunk))) {
            for (const listener of [...listeners]) {
              listener(message);
            }
          }
        }
      } catch (error) {
        if (state === 'open') {
          onDiagnostic(getErrorDetails(error));
        }
      } finally {
        notifyClosed();
      }
    })();
  };

  return {
    get state() {
      return state;
    },
    maxMessageBytes,
    protocolId,
    close: async (options?: ClosePeerNetworkOptions) => {
      if (state === 'closed') {
        return;
      }
      options?.signal?.throwIfAborted();
      await stream.close(options?.signal ? { signal: options.signal } : undefined);
      notifyClosed();
    },
    onClose: (listener) => {
      if (state === 'closed') {
        listener();
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    onMessage: (listener) => {
      if (state === 'closed') {
        throw new PeerNetworkError('channel-closed', { protocolId });
      }
      listeners.add(listener);
      startReading();
      return () => {
        listeners.delete(listener);
      };
    },
    send: async (message, options?: SendPeerMessageOptions) => {
      if (state === 'closed') {
        throw new PeerNetworkError('channel-closed', { protocolId });
      }
      options?.signal?.throwIfAborted();
      const frame = codec.encode(message);
      await runPeerNetworkOperation({
        operation: async (signal) => {
          while (!stream.send(frame)) {
            signal.throwIfAborted();
            await stream.onDrain({ signal });
          }
        },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        timeoutCode: 'send-timeout',
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    },
  };
};

export const createLibp2pPeerNetwork = async ({
  maxMessageBytes = defaultMaxMessageBytes,
  node,
}: CreateLibp2pPeerNetworkOptions): Promise<PeerNetwork> => {
  if (node.status !== 'started') {
    await node.start();
  }

  const connectionListeners = new Set<PeerConnectionListener>();
  const eventListeners = new Set<PeerNetworkEventListener>();
  const protocolRegistrations = new Map<string, ProtocolRegistrationState>();
  let closed = false;

  const emit = (event: PeerNetworkEvent): void => {
    for (const listener of [...eventListeners]) {
      listener(event);
    }
  };

  const createConnection = (remotePeerId: string): PeerConnection => ({
    remotePeerId,
    close: async (options) => {
      options?.signal?.throwIfAborted();
      await node.hangUp(
        peerIdFromString(remotePeerId),
        options?.signal ? { signal: options.signal } : undefined,
      );
    },
    openChannel: async (protocolId, options) => {
      if (closed) {
        throw new PeerNetworkError('network-closed');
      }
      options?.signal?.throwIfAborted();
      try {
        const stream = await runPeerNetworkOperation({
          operation: async (signal) => node.dialProtocol(
            peerIdFromString(remotePeerId),
            protocolId,
            { signal },
          ),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          timeoutCode: 'channel-open-timeout',
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        return createLibp2pMessageChannel(
          stream,
          protocolId,
          maxMessageBytes,
          (details) => emit({
            code: 'channel-read-failed',
            details: { ...details, protocolId, remotePeerId },
            type: 'diagnostic',
          }),
        );
      } catch (error) {
        if (error instanceof PeerNetworkError || options?.signal?.aborted === true) {
          throw error;
        }
        throw new PeerNetworkError(
          'protocol-rejected',
          { protocolId, remotePeerId, ...getErrorDetails(error) },
          { cause: error },
        );
      }
    },
  });

  const onPeerConnect = (event: Event): void => {
    const remotePeerId = (event as CustomEvent<{ toString(): string }>).detail.toString();
    const connection = createConnection(remotePeerId);
    for (const listener of [...connectionListeners]) {
      listener(connection);
    }
    emit({ connection, type: 'peer-connected' });
  };

  const onPeerDisconnect = (event: Event): void => {
    const peerId = (event as CustomEvent<{ toString(): string }>).detail.toString();
    emit({ peerId, type: 'peer-disconnected' });
  };

  node.addEventListener('peer:connect', onPeerConnect);
  node.addEventListener('peer:disconnect', onPeerDisconnect);
  const localPeerId = node.peerId.toString();

  return {
    get endpoint() {
      return {
        addresses: node.getMultiaddrs().map((address) => address.toString()),
        peerId: localPeerId,
      };
    },
    localPeerId,
    close: async (options) => {
      if (closed) {
        return;
      }
      options?.signal?.throwIfAborted();
      closed = true;
      node.removeEventListener('peer:connect', onPeerConnect);
      node.removeEventListener('peer:disconnect', onPeerDisconnect);
      await Promise.all(
        [...protocolRegistrations].map(async ([protocolId, registration]) => {
          protocolRegistrations.delete(protocolId);
          try {
            await registration.installation;
          } catch {
            return;
          }
          await node.unhandle(protocolId);
        }),
      );
      connectionListeners.clear();
      eventListeners.clear();
      await node.stop();
    },
    connect: async (remoteEndpoint, options) => {
      if (closed) {
        throw new PeerNetworkError('network-closed');
      }
      if (remoteEndpoint.peerId.length === 0 || remoteEndpoint.addresses.length === 0) {
        throw new PeerNetworkError('invalid-endpoint');
      }
      options?.signal?.throwIfAborted();
      const peerId = peerIdFromString(remoteEndpoint.peerId);
      try {
        await node.peerStore.merge(peerId, {
          multiaddrs: remoteEndpoint.addresses.map((address) => multiaddr(address)),
        });
        await runPeerNetworkOperation({
          operation: async (signal) => node.dial(peerId, { signal }),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          timeoutCode: 'connect-timeout',
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        return createConnection(remoteEndpoint.peerId);
      } catch (error) {
        if (error instanceof PeerNetworkError || options?.signal?.aborted === true) {
          throw error;
        }
        throw new PeerNetworkError(
          'peer-unreachable',
          { peerId: remoteEndpoint.peerId, ...getErrorDetails(error) },
          { cause: error },
        );
      }
    },
    onConnection: (listener) => {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onProtocolChannel: async (protocolId, listener) => {
      if (closed) {
        throw new PeerNetworkError('network-closed');
      }
      let registration = protocolRegistrations.get(protocolId);
      if (registration === undefined) {
        registration = {
          installation: Promise.resolve(),
          listeners: new Set(),
        };
        protocolRegistrations.set(protocolId, registration);
        const currentRegistration = registration;
        registration.installation = node.handle(
          protocolId,
          async (stream, connection) => {
            const remotePeerId = connection.remotePeer.toString();
            emit({
              code: 'protocol-channel-accepted',
              details: { protocolId, remotePeerId },
              type: 'diagnostic',
            });
            const peerConnection = createConnection(remotePeerId);
            const channel = createLibp2pMessageChannel(
              stream,
              protocolId,
              maxMessageBytes,
              (details) => emit({
                code: 'channel-read-failed',
                details: { ...details, protocolId, remotePeerId },
                type: 'diagnostic',
              }),
            );
            for (const protocolListener of [...currentRegistration.listeners]) {
              protocolListener(channel, peerConnection);
            }
            await new Promise<void>((resolve) => {
              stream.addEventListener('close', () => resolve(), { once: true });
            });
          },
        );
      }
      registration.listeners.add(listener);

      try {
        await registration.installation;
      } catch (error) {
        if (protocolRegistrations.get(protocolId) === registration) {
          protocolRegistrations.delete(protocolId);
        }
        throw error;
      }

      let subscribed = true;
      return async () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        registration.listeners.delete(listener);
        if (
          registration.listeners.size === 0
          && protocolRegistrations.get(protocolId) === registration
        ) {
          protocolRegistrations.delete(protocolId);
          await registration.installation;
          await node.unhandle(protocolId);
        }
      };
    },
  };
};
