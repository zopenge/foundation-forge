import { afterEach, describe, expect, test } from 'vitest';

import type { PeerMessageChannel, PeerNetwork } from '@openge/forge-peer-network';

import { createLibp2pNodePeerNetwork } from '../src/node.js';

const protocolId = '/openge.peer-network/test/1.0.0';

const waitForStage = async <Value>(
  stage: string,
  promise: Promise<Value>,
): Promise<Value> => Promise.race([
  promise,
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`stage-timeout:${stage}`)), 2_000);
  }),
]);

const createInboundChannelWaiter = (
  network: PeerNetwork,
): {
  readonly channel: Promise<PeerMessageChannel>;
  readonly ready: Promise<void>;
} => {
  let resolveChannel: (channel: PeerMessageChannel) => void = () => undefined;
  const channel = new Promise<PeerMessageChannel>((resolve) => {
    resolveChannel = resolve;
  });
  const ready = network.onProtocolChannel(protocolId, resolveChannel).then(
    () => undefined,
  );
  return { channel, ready };
};

const waitForMessages = (
  channel: PeerMessageChannel,
  count: number,
): Promise<readonly Uint8Array[]> =>
  new Promise((resolve) => {
    const messages: Uint8Array[] = [];
    const unsubscribe = channel.onMessage((message) => {
      messages.push(message);
      if (messages.length === count) {
        unsubscribe();
        resolve(messages);
      }
    });
  });

describe('libp2p node peer network', () => {
  const networks: PeerNetwork[] = [];

  afterEach(async () => {
    await Promise.all(networks.splice(0).map(async (network) => network.close()));
  });

  test('connects by endpoint and exchanges ordered messages', async () => {
    const requester = await createLibp2pNodePeerNetwork();
    const worker = await createLibp2pNodePeerNetwork();
    networks.push(requester, worker);
    const inbound = createInboundChannelWaiter(worker);
    await waitForStage('protocol-ready', inbound.ready);

    const connection = await waitForStage('connect', requester.connect(worker.endpoint));
    const outbound = await waitForStage(
      'open-channel',
      connection.openChannel(protocolId),
    );

    await outbound.send(Uint8Array.from([1]));
    await outbound.send(Uint8Array.from([2]));
    const inboundChannel = await waitForStage('inbound-channel', inbound.channel);

    expect(await waitForStage('messages', waitForMessages(inboundChannel, 2))).toEqual([
      Uint8Array.from([1]),
      Uint8Array.from([2]),
    ]);
  });

  test('supports request and response on the same channel', async () => {
    const requester = await createLibp2pNodePeerNetwork();
    const worker = await createLibp2pNodePeerNetwork();
    networks.push(requester, worker);
    await worker.onProtocolChannel(protocolId, (channel) => {
      channel.onMessage((message) => {
        void channel.send(Uint8Array.from([message[0] ?? 0, 2]));
      });
    });

    const connection = await requester.connect(worker.endpoint);
    const channel = await connection.openChannel(protocolId);
    const response = waitForMessages(channel, 1);
    await channel.send(Uint8Array.from([1]));

    expect(await waitForStage('response', response)).toEqual([
      Uint8Array.from([1, 2]),
    ]);
  });

  test('enforces the configured message limit', async () => {
    const requester = await createLibp2pNodePeerNetwork({ maxMessageBytes: 2 });
    const worker = await createLibp2pNodePeerNetwork({ maxMessageBytes: 2 });
    networks.push(requester, worker);
    const inbound = createInboundChannelWaiter(worker);
    await inbound.ready;
    const connection = await requester.connect(worker.endpoint);
    const channel = await connection.openChannel(protocolId);

    await expect(channel.send(Uint8Array.from([1, 2, 3]))).rejects.toMatchObject({
      code: 'message-too-large',
    });
  });
});
