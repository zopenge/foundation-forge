import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import type { PeerNetwork, PeerNetworkProvider } from '@openge/forge-peer-network';
import { createLibp2p } from 'libp2p';

import { createLibp2pPeerNetwork } from './libp2p-peer-network.js';

export interface CreateLibp2pNodePeerNetworkOptions {
  readonly listen?: readonly string[];
  readonly maxMessageBytes?: number;
}

export const createLibp2pNodePeerNetwork = async (
  options: CreateLibp2pNodePeerNetworkOptions = {},
): Promise<PeerNetwork> => {
  const node = await createLibp2p({
    addresses: {
      listen: [...(options.listen ?? ['/ip4/127.0.0.1/tcp/0'])],
    },
    connectionEncrypters: [noise()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: { identify: identify() },
    start: false,
    streamMuxers: [yamux()],
    transports: [tcp(), webSockets()],
  });

  return createLibp2pPeerNetwork({
    ...(options.maxMessageBytes === undefined
      ? {}
      : { maxMessageBytes: options.maxMessageBytes }),
    node,
  });
};

export const createLibp2pNodePeerNetworkProvider = (
  options: CreateLibp2pNodePeerNetworkOptions = {},
): PeerNetworkProvider => ({
  createNetwork: async (createOptions) => {
    createOptions?.signal?.throwIfAborted();
    const network = await createLibp2pNodePeerNetwork(options);
    if (createOptions?.signal?.aborted === true) {
      await network.close();
      createOptions.signal.throwIfAborted();
    }
    return network;
  },
});
