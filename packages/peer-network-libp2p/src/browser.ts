import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import type { PeerNetwork, PeerNetworkProvider } from '@openge/forge-peer-network';
import { createLibp2p } from 'libp2p';

import { createLibp2pPeerNetwork } from './libp2p-peer-network.js';

export interface CreateLibp2pBrowserPeerNetworkOptions {
  readonly listen?: readonly string[];
  readonly maxMessageBytes?: number;
}

export const createLibp2pBrowserPeerNetwork = async (
  options: CreateLibp2pBrowserPeerNetworkOptions = {},
): Promise<PeerNetwork> => {
  const node = await createLibp2p({
    addresses: {
      listen: [...(options.listen ?? ['/p2p-circuit', '/webrtc'])],
    },
    connectionEncrypters: [noise()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: { identify: identify() },
    start: false,
    streamMuxers: [yamux()],
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
  });

  return createLibp2pPeerNetwork({
    ...(options.maxMessageBytes === undefined
      ? {}
      : { maxMessageBytes: options.maxMessageBytes }),
    node,
  });
};

export const createLibp2pBrowserPeerNetworkProvider = (
  options: CreateLibp2pBrowserPeerNetworkOptions = {},
): PeerNetworkProvider => ({
  createNetwork: async (createOptions) => {
    createOptions?.signal?.throwIfAborted();
    const network = await createLibp2pBrowserPeerNetwork(options);
    if (createOptions?.signal?.aborted === true) {
      await network.close();
      createOptions.signal.throwIfAborted();
    }
    return network;
  },
});
