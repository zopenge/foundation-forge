import type { PeerNetwork, PeerNetworkProvider } from '@openge/forge-peer-network';
import { afterEach, describe, expect, test } from 'vitest';

export const verifyPeerNetworkProviderConformance = (
  providerName: string,
  createProvider: () => PeerNetworkProvider,
): void => {
  describe(`${providerName} provider conformance`, () => {
    const networks: PeerNetwork[] = [];

    afterEach(async () => {
      await Promise.all(networks.splice(0).map(async (network) => network.close()));
    });

    test('creates a network with a stable local endpoint', async () => {
      const network = await createProvider().createNetwork();
      networks.push(network);

      expect(network.localPeerId).not.toHaveLength(0);
      expect(network.endpoint.peerId).toBe(network.localPeerId);
      expect(Array.isArray(network.endpoint.addresses)).toBe(true);
    });

    test('closes the network and listener registrations idempotently', async () => {
      const network = await createProvider().createNetwork();
      networks.push(network);
      const removeConnectionListener = network.onConnection(() => undefined);
      const removeEventListener = network.onEvent(() => undefined);

      removeConnectionListener();
      removeConnectionListener();
      removeEventListener();
      removeEventListener();
      await network.close();
      await expect(network.close()).resolves.toBeUndefined();
    });

    test('honors an already aborted creation signal', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(createProvider().createNetwork({
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
};
