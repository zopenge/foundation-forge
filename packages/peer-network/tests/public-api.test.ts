import { describe, expect, test } from 'vitest';

describe('peer network public API', () => {
  test('exports the structured error and framing contracts', async () => {
    const api = await import('../src/index.js');

    expect(api).toHaveProperty('PeerNetworkError');
    expect(api).toHaveProperty('peerNetworkErrorCodes');
    expect(api).toHaveProperty('createLengthPrefixedFrameCodec');
  });

  test('does not expose provider-specific symbols from the root', async () => {
    const api = await import('../src/index.js');

    expect(api).not.toHaveProperty('createLibp2pBrowserPeerNetwork');
    expect(api).not.toHaveProperty('createLibp2pNodePeerNetwork');
    expect(api).not.toHaveProperty('createLibp2pRelay');
    expect(api).not.toHaveProperty('createWebSocketPeerDiscovery');
  });
});
