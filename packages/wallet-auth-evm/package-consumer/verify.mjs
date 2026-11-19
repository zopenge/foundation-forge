import { createEvmWalletMessage, verifyEvmWalletProof } from '@openge/forge-wallet-auth-evm';

const challenge = {
  id: 'pack-test', purpose: 'link', audience: 'https://wallet.example',
  uri: 'https://wallet.example/link', nonce: 'a1b2c3d4e5f6', issuedAt: '2026-11-19T08:00:00Z',
  expiresAt: '2026-11-19T08:02:00Z',
  account: { namespace: 'eip155', network: '1', address: '0x0000000000000000000000000000000000000011' }
};
const message = createEvmWalletMessage(challenge);
const result = await verifyEvmWalletProof({
  challenge,
  proof: { challengeId: challenge.id, message, signature: '0x0102' },
  now: new Date('2026-11-19T08:01:00Z')
});
if (!message.includes('Request ID: pack-test') || result.ok || result.code !== 'invalid-signature') {
  throw new Error('Installed EVM verifier did not enforce the signature');
}
