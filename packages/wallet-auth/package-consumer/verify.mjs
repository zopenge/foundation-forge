import { validateWalletChallenge } from '@openge/forge-wallet-auth';

const challenge = {
  id: 'pack-test', purpose: 'sign-in', audience: 'https://wallet.example',
  uri: 'https://wallet.example/login', nonce: 'a1b2c3d4e5f6', issuedAt: '2026-11-19T08:00:00Z',
  expiresAt: '2026-11-19T08:02:00Z', account: { namespace: 'example', network: 'test', address: 'account-1' }
};
if (!validateWalletChallenge(challenge, new Date('2026-11-19T08:01:00Z')).ok) {
  throw new Error('Wallet challenge could not be validated from the installed package');
}
