import { describe, expect, test } from 'vitest';

import { createLibp2pBrowserPeerNetworkProvider } from '../src/browser.js';

describe('libp2p browser peer network provider', () => {
  test('creates a network with an explicit empty listen set', async () => {
    const provider = createLibp2pBrowserPeerNetworkProvider({ listen: [] });
    const network = await provider.createNetwork();

    try {
      expect(network.endpoint.addresses).toEqual([]);
      expect(network.localPeerId).not.toHaveLength(0);
    } finally {
      await network.close();
    }
  });

  test('rejects an already aborted creation before allocating a network', async () => {
    const provider = createLibp2pBrowserPeerNetworkProvider({ listen: [] });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.createNetwork({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
