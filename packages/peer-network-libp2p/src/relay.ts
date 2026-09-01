import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { identify } from '@libp2p/identify';
import { webSockets } from '@libp2p/websockets';
import type { PeerEndpoint } from '@openge/forge-peer-network';
import { createLibp2p } from 'libp2p';

export interface Libp2pRelay {
  readonly endpoint: PeerEndpoint;
  close(): Promise<void>;
}

export interface CreateLibp2pRelayOptions {
  readonly listen?: readonly string[];
  readonly privateKeyProtobuf?: Uint8Array;
}

export const createLibp2pRelay = async (
  options: CreateLibp2pRelayOptions = {},
): Promise<Libp2pRelay> => {
  const node = await createLibp2p({
    addresses: {
      listen: [...(options.listen ?? ['/ip4/127.0.0.1/tcp/0/ws'])],
    },
    connectionEncrypters: [noise()],
    connectionGater: { denyDialMultiaddr: () => false },
    ...(options.privateKeyProtobuf === undefined
      ? {}
      : { privateKey: privateKeyFromProtobuf(options.privateKeyProtobuf) }),
    services: {
      circuitRelay: circuitRelayServer(),
      identify: identify(),
    },
    start: false,
    streamMuxers: [yamux()],
    transports: [webSockets()],
  });
  await node.start();

  return {
    endpoint: {
      addresses: node.getMultiaddrs().map((address) => address.toString()),
      peerId: node.peerId.toString(),
    },
    close: async () => {
      await node.stop();
    },
  };
};
