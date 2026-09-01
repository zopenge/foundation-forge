export interface PeerEndpoint {
  readonly addresses: readonly string[];
  readonly peerId: string;
}

export interface PeerAdvertisement {
  readonly endpoint: PeerEndpoint;
  readonly scopeId: string;
}

export interface ConnectPeerOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface OpenPeerChannelOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SendPeerMessageOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ClosePeerNetworkOptions {
  readonly signal?: AbortSignal;
}

export type PeerMessageListener = (message: Uint8Array) => void;
export type PeerChannelCloseListener = () => void;

export interface PeerMessageChannel {
  readonly maxMessageBytes: number;
  readonly protocolId: string;
  readonly state: 'closed' | 'open';
  close(options?: ClosePeerNetworkOptions): Promise<void>;
  onClose(listener: PeerChannelCloseListener): () => void;
  onMessage(listener: PeerMessageListener): () => void;
  send(message: Uint8Array, options?: SendPeerMessageOptions): Promise<void>;
}

export interface PeerConnection {
  readonly remotePeerId: string;
  close(options?: ClosePeerNetworkOptions): Promise<void>;
  openChannel(
    protocolId: string,
    options?: OpenPeerChannelOptions,
  ): Promise<PeerMessageChannel>;
}

export type PeerConnectionListener = (connection: PeerConnection) => void;

export type PeerProtocolChannelListener = (
  channel: PeerMessageChannel,
  connection: PeerConnection,
) => void;

export type PeerNetworkEvent =
  | { readonly connection: PeerConnection; readonly type: 'peer-connected' }
  | { readonly peerId: string; readonly type: 'peer-disconnected' }
  | {
      readonly code: string;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly type: 'diagnostic';
    };

export type PeerNetworkEventListener = (event: PeerNetworkEvent) => void;

export interface PeerNetwork {
  readonly endpoint: PeerEndpoint;
  readonly localPeerId: string;
  close(options?: ClosePeerNetworkOptions): Promise<void>;
  connect(
    endpoint: PeerEndpoint,
    options?: ConnectPeerOptions,
  ): Promise<PeerConnection>;
  onConnection(listener: PeerConnectionListener): () => void;
  onEvent(listener: PeerNetworkEventListener): () => void;
  onProtocolChannel(
    protocolId: string,
    listener: PeerProtocolChannelListener,
  ): Promise<() => Promise<void>>;
}

export interface PeerNetworkProvider {
  createNetwork(options?: { readonly signal?: AbortSignal }): Promise<PeerNetwork>;
}

export type PeerDiscoveryListener = (
  advertisements: readonly PeerAdvertisement[],
) => void;

export interface PeerDiscovery {
  close(): void;
  onAdvertisements(listener: PeerDiscoveryListener): () => void;
  publish(advertisement: PeerAdvertisement): void;
}
