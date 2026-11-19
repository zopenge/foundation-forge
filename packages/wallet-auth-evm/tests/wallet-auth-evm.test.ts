import { describe, expect, it } from 'vitest';
import { parseSignature, serializeCompactSignature, signatureToCompactSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { WalletChallenge } from '@openge/forge-wallet-auth';
import { createErc1271Verifier, createEvmWalletMessage, verifyEvmWalletProof } from '../src/index.js';

const signer = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
const expected: WalletChallenge = {
  id: 'request-1',
  purpose: 'sign-in',
  audience: 'https://example.com',
  uri: 'https://example.com/account',
  nonce: '1234abcd5678abcd',
  issuedAt: '2026-11-19T08:00:00.000Z',
  expiresAt: '2026-11-19T08:02:00.000Z',
  account: { namespace: 'eip155', network: '1', address: signer.address }
};
const now = new Date('2026-11-19T08:01:00Z');

describe('EVM wallet authentication', () => {
  it('verifies a real signature against the stored challenge', async () => {
    const message = createEvmWalletMessage(expected);
    expect(message).toContain('https://example.com wants you to sign in with your Ethereum account:');
    expect(message).toContain('Request ID: request-1');
    const proof = { challengeId: expected.id, message, signature: await signer.signMessage({ message }) };
    await expect(verifyEvmWalletProof({ challenge: expected, proof, now })).resolves.toEqual({
      ok: true, account: { namespace: 'eip155', network: '1', address: signer.address.toLowerCase() }
    });
    await expect(verifyEvmWalletProof({ challenge: { ...expected, purpose: 'link' }, proof, now }))
      .resolves.toEqual({ ok: false, code: 'challenge-mismatch' });
    await expect(verifyEvmWalletProof({ challenge: expected, proof, now: new Date(expected.expiresAt) }))
      .resolves.toEqual({ ok: false, code: 'expired' });
  });

  it('does not accept a signature for another domain or a changed nonce', async () => {
    const message = createEvmWalletMessage(expected);
    const proof = { challengeId: expected.id, message, signature: await signer.signMessage({ message }) };
    for (const challenge of [
      { ...expected, audience: 'https://other.example', uri: 'https://other.example/account' },
      { ...expected, nonce: 'aabbccdd11223344' }
    ]) {
      await expect(verifyEvmWalletProof({ challenge, proof, now })).resolves
        .toEqual({ ok: false, code: 'challenge-mismatch' });
    }
  });

  it('recovers a real compact EIP-2098 signature', async () => {
    const message = createEvmWalletMessage(expected);
    const signature = serializeCompactSignature(signatureToCompactSignature(parseSignature(await signer.signMessage({ message }))));
    expect(signature).toHaveLength(130);
    await expect(verifyEvmWalletProof({ challenge: expected, proof: { challengeId: expected.id, message, signature }, now }))
      .resolves.toEqual({ ok: true, account: { ...expected.account, address: signer.address.toLowerCase() } });
  });

  it('returns a structured failure for a compact signature with invalid scalars', async () => {
    const message = createEvmWalletMessage(expected);
    const proof = { challengeId: expected.id, message, signature: `0x${'00'.repeat(64)}` };
    await expect(verifyEvmWalletProof({ challenge: expected, proof, now }))
      .resolves.toEqual({ ok: false, code: 'invalid-signature' });
  });

  it('enforces the explicitly selected contract verifier even when EOA recovery would match', async () => {
    const message = createEvmWalletMessage(expected);
    const proof = { challengeId: expected.id, message, signature: await signer.signMessage({ message }) };
    await expect(verifyEvmWalletProof({ challenge: expected, proof, now, verifyContractSignature: async () => false }))
      .resolves.toEqual({ ok: false, code: 'invalid-signature' });
  });

  it('rejects a non-boolean success result from a JavaScript contract verifier', async () => {
    const message = createEvmWalletMessage(expected);
    const proof = { challengeId: expected.id, message, signature: '0x0102' };
    // 模拟未通过 TypeScript 检查的 JavaScript 消费者。
    const verifyContractSignature = new Proxy(async () => false, { apply: () => Promise.resolve({ valid: false }) });
    await expect(verifyEvmWalletProof({ challenge: expected, proof, now, verifyContractSignature }))
      .resolves.toEqual({ ok: false, code: 'invalid-signature' });
  });

  it('rejects a transport response object that coerces to the ERC-1271 magic string', async () => {
    const read = new Proxy(async () => '0x', { apply: () => Promise.resolve({ toString: () => '0x1626ba7e' }) });
    await expect(createErc1271Verifier(read)({ account: expected.account,
      messageHash: `0x${'00'.repeat(32)}`, signature: '0x0102' })).resolves.toBe(false);
  });

  it('returns a structured failure for a null signature in a client proof', async () => {
    const message = createEvmWalletMessage(expected);
    const proof = new Proxy({ challengeId: expected.id, message, signature: '0x0102' }, {
      get: (value, key, receiver) => key === 'signature' ? null : Reflect.get(value, key, receiver)
    });
    await expect(verifyEvmWalletProof({ challenge: expected, proof, now })).resolves.toEqual({ ok: false, code: 'invalid-signature' });
  });

  it('returns the package error for an IPv6 loopback authority that SIWE generation cannot represent', () => {
    expect(() => createEvmWalletMessage({ ...expected, audience: 'http://[::1]', uri: 'http://[::1]/account' }))
      .toThrow(expect.objectContaining({ code: 'invalid-challenge' }));
  });

  it('asks the trusted contract verifier about the signed hash on the declared chain', async () => {
    const address = '0x0000000000000000000000000000000000000011';
    const challenge = { ...expected, account: { ...expected.account, address, network: '8453' } };
    const message = createEvmWalletMessage(challenge);
    const proof = { challengeId: challenge.id, message, signature: '0x0102' };
    await expect(verifyEvmWalletProof({
      challenge, proof, now,
      verifyContractSignature: ({ account, messageHash, signature }) => Promise.resolve(
        account.network === '8453' && account.address === address && /^0x[a-f0-9]{64}$/u.test(messageHash) && signature === '0x0102'
      )
    })).resolves.toEqual({ ok: true, account: challenge.account });
    await expect(verifyEvmWalletProof({ challenge, proof, now })).resolves
      .toEqual({ ok: false, code: 'invalid-signature' });
  });
});
