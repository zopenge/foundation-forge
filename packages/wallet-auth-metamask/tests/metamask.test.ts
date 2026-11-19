import { describe, expect, it } from 'vitest';
import type { WalletChallenge } from '@openge/forge-wallet-auth';
import { createMetaMaskWallet, discoverMetaMask, type MetaMaskProvider } from '../src/browser.js';

const address = '0x0000000000000000000000000000000000000011';
const challenge: WalletChallenge = {
  id: 'request-1', purpose: 'sign-in', audience: 'https://example.com', uri: 'https://example.com/account',
  nonce: '1234abcd5678abcd', issuedAt: '2026-11-19T08:00:00.000Z', expiresAt: '2026-11-19T08:02:00.000Z',
  account: { namespace: 'eip155', network: '1', address }
};

function providerFixture(changeDuringPrompt = false) {
  const listeners = new Map<string, Set<() => void>>();
  const provider: MetaMaskProvider = {
    request: ({ method }) => {
      if (method === 'eth_chainId') return Promise.resolve('0x1');
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return Promise.resolve([address]);
      if (method !== 'personal_sign') return Promise.reject(new Error('Unexpected wallet request'));
      if (changeDuringPrompt) for (const listener of listeners.get('accountsChanged') ?? []) listener();
      return Promise.resolve('0x0102');
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener); }
  };
  return { provider, listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0) };
}

describe('MetaMask browser integration', () => {
  it('discovers the MetaMask announcement and disposes the subscription', () => {
    const target = new EventTarget();
    const { provider } = providerFixture();
    const announce = () => target.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { provider, info: { rdns: 'io.metamask', uuid: 'test' } }
    }));
    target.addEventListener('eip6963:requestProvider', announce);
    const providers: MetaMaskProvider[] = [];
    const dispose = discoverMetaMask(target, candidate => { providers.push(candidate.provider); });
    dispose();
    announce();
    expect(providers).toEqual([provider]);
  });

  it('connects and returns the exact signed proof while releasing listeners', async () => {
    const { provider, listenerCount } = providerFixture();
    const wallet = createMetaMaskWallet(provider);
    await expect(wallet.connect()).resolves.toEqual(challenge.account);
    await expect(wallet.sign({ challenge, message: 'server message' })).resolves.toEqual({
      challengeId: challenge.id, message: 'server message', signature: '0x0102'
    });
    expect(listenerCount()).toBe(0);
  });

  it('rejects a result after an account-change event during the signature prompt', async () => {
    const { provider, listenerCount } = providerFixture(true);
    const wallet = createMetaMaskWallet(provider);
    await expect(wallet.sign({ challenge, message: 'server message' })).rejects.toMatchObject({ code: 'account-changed' });
    expect(listenerCount()).toBe(0);
  });

  it('releases listeners on abort before a pending wallet prompt settles', async () => {
    const { provider, listenerCount } = providerFixture();
    const initialRequest = provider.request.bind(provider);
    let enter = () => {};
    let rejectPrompt!: (error: Error) => void;
    const entered = new Promise<void>(accept => { enter = accept; });
    const pending = new Promise<never>((_accept, reject) => { rejectPrompt = reject; });
    provider.request = input => {
      if (input.method !== 'personal_sign') return initialRequest(input);
      enter();
      return pending;
    };
    const controller = new AbortController();
    const result = createMetaMaskWallet(provider).sign({ challenge, message: 'server message' }, controller.signal)
      .then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await Promise.race([entered, result.then(value => { throw new Error('Wallet settled before the prompt', { cause: value }); })]);
      controller.abort();
      const state = await Promise.race([result, new Promise(accept => setImmediate(accept, 'still waiting'))]);
      expect(state).toMatchObject({ error: { code: 'cancelled' } });
      expect(listenerCount()).toBe(0);
    } finally {
      rejectPrompt(new Error('Wallet closed after cancellation'));
      await result;
    }
  });
});
