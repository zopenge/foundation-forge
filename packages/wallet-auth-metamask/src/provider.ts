import { WalletAuthError, type WalletAccount, type WalletConnector, type WalletSigningRequest } from '@openge/forge-wallet-auth';

type ProviderEvent = 'accountsChanged' | 'chainChanged' | 'disconnect';
type ProviderRequest = { readonly method: string; readonly params?: readonly string[] };

export interface MetaMaskProvider {
  request(input: ProviderRequest): Promise<unknown>;
  on(event: ProviderEvent, listener: () => void): void;
  removeListener(event: ProviderEvent, listener: () => void): void;
}

const monitoredEvents: readonly ProviderEvent[] = ['accountsChanged', 'chainChanged', 'disconnect'];

export function isMetaMaskProvider(value: unknown): value is MetaMaskProvider {
  return value !== null && typeof value === 'object' &&
    'request' in value && typeof value.request === 'function' &&
    'on' in value && typeof value.on === 'function' &&
    'removeListener' in value && typeof value.removeListener === 'function';
}

async function request(provider: MetaMaskProvider, input: ProviderRequest, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new WalletAuthError('cancelled');
  let cancel: (() => void) | undefined;
  try {
    const pending = provider.request(input);
    if (!signal) return await pending;
    const cancelled = new Promise<never>((_accept, reject) => {
      cancel = () => reject(new WalletAuthError('cancelled'));
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
    return await Promise.race([pending, cancelled]);
  } catch (error) {
    if (signal?.aborted) throw new WalletAuthError('cancelled');
    const rejected = error !== null && typeof error === 'object' && 'code' in error && error.code === 4001;
    throw new WalletAuthError(rejected ? 'wallet-rejected' : 'wallet-unavailable');
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

async function currentAccount(provider: MetaMaskProvider, method: 'eth_accounts' | 'eth_requestAccounts', signal?: AbortSignal): Promise<WalletAccount> {
  const accounts: unknown = await request(provider, { method }, signal);
  const address: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
  const chain = await request(provider, { method: 'eth_chainId' }, signal);
  if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/iu.test(address) ||
    typeof chain !== 'string' || !/^0x[0-9a-f]{1,14}$/iu.test(chain)) throw new WalletAuthError('wallet-unavailable');

  const chainId = Number(chain);
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new WalletAuthError('wallet-unavailable');
  return { namespace: 'eip155', network: String(chainId), address: address.toLowerCase() };
}

function requireAccount(actual: WalletAccount, expected: WalletAccount): void {
  if (actual.namespace !== expected.namespace || actual.network !== expected.network || actual.address !== expected.address.toLowerCase()) {
    throw new WalletAuthError('account-changed');
  }
}

export function createMetaMaskWallet(provider: MetaMaskProvider): WalletConnector {
  return {
    connect: () => currentAccount(provider, 'eth_requestAccounts'),
    async sign({ challenge, message }: WalletSigningRequest, signal?: AbortSignal) {
      let changed = false;
      const markChanged = () => { changed = true; };
      const ensureCurrent = () => {
        if (signal?.aborted) throw new WalletAuthError('cancelled');
        if (changed) throw new WalletAuthError('account-changed');
      };
      ensureCurrent();
      const subscribed: ProviderEvent[] = [];
      try {
        for (const event of monitoredEvents) {
          provider.on(event, markChanged);
          subscribed.push(event);
        }

        const account = await currentAccount(provider, 'eth_accounts', signal);
        requireAccount(account, challenge.account);
        ensureCurrent();
        const hex = Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('');
        const signature = await request(provider, { method: 'personal_sign', params: [`0x${hex}`, account.address] }, signal);
        ensureCurrent();
        requireAccount(await currentAccount(provider, 'eth_accounts', signal), challenge.account);
        ensureCurrent();
        if (typeof signature !== 'string' || !/^0x(?:[a-f0-9]{2}){1,8192}$/iu.test(signature)) {
          throw new WalletAuthError('invalid-signature');
        }
        return { challengeId: challenge.id, message, signature };
      } finally {
        for (const event of subscribed) provider.removeListener(event, markChanged);
      }
    }
  };
}
