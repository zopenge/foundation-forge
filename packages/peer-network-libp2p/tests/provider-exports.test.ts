import { describe, expect, test } from 'vitest';

describe('libp2p provider entrypoints', () => {
  test('exports each provider only from its explicit entrypoint', async () => {
    const [browser, node, relay] = await Promise.all([
      import('../src/browser.js'),
      import('../src/node.js'),
      import('../src/relay.js'),
    ]);

    expect(browser).toHaveProperty('createLibp2pBrowserPeerNetwork');
    expect(browser).toHaveProperty('createLibp2pBrowserPeerNetworkProvider');
    expect(node).toHaveProperty('createLibp2pNodePeerNetwork');
    expect(node).toHaveProperty('createLibp2pNodePeerNetworkProvider');
    expect(relay).toHaveProperty('createLibp2pRelay');
    expect(browser).not.toHaveProperty('createLibp2pRelay');
    expect(node).not.toHaveProperty('createLibp2pRelay');
  }, 15_000);
});
