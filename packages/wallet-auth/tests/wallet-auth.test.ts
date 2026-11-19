import { describe, expect, it } from 'vitest';
import { validateWalletChallenge, type WalletChallenge } from '../src/index.js';

const challenge: WalletChallenge = {
  id: 'request-1',
  purpose: 'sign-in',
  audience: 'https://example.com',
  uri: 'https://example.com/account',
  nonce: '1234abcd5678abcd',
  issuedAt: '2026-11-19T08:00:00.000Z',
  expiresAt: '2026-11-19T08:02:00.000Z',
  account: { namespace: 'eip155', network: '1', address: '0x123' }
};

describe('wallet challenge', () => {
  it('accepts a current challenge addressed to the same origin', () => {
    expect(validateWalletChallenge(challenge, new Date('2026-11-19T08:01:00Z'))).toEqual({ ok: true });
  });

  it.each(['id', 'nonce', 'account'] as const)('rejects a stored challenge with no %s', field => {
    const incomplete = new Proxy(challenge, {
      get: (value, key, receiver) => key === field ? undefined : Reflect.get(value, key, receiver)
    });
    expect(validateWalletChallenge(incomplete, new Date('2026-11-19T08:01:00Z')))
      .toEqual({ ok: false, code: 'invalid-challenge' });
  });

  it('rejects a URI at another origin and rejects expired challenges', () => {
    expect(validateWalletChallenge({ ...challenge, uri: 'https://other.example/account' }, new Date(challenge.issuedAt)))
      .toEqual({ ok: false, code: 'invalid-challenge' });
    expect(validateWalletChallenge(challenge, new Date(challenge.expiresAt))).toEqual({ ok: false, code: 'expired' });
  });
});
