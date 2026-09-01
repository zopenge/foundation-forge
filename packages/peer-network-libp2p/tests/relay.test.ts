import {
  generateKeyPair,
  privateKeyToProtobuf,
} from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { expect, test } from 'vitest';

import { createLibp2pRelay } from '../src/relay.js';

test('libp2p relay restores an identity from provider-owned bytes', async () => {
  const privateKey = await generateKeyPair('Ed25519');
  const expectedPeerId = peerIdFromPrivateKey(privateKey).toString();
  const relay = await createLibp2pRelay({
    privateKeyProtobuf: privateKeyToProtobuf(privateKey),
  });

  try {
    expect(relay.endpoint.peerId).toBe(expectedPeerId);
  } finally {
    await relay.close();
  }
});
