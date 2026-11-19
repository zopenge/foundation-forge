import { WalletAuthError } from '@openge/forge-wallet-auth';
import { isMetaMaskProvider, type MetaMaskProvider } from './provider.js';

export interface MetaMaskAnnouncement {
  readonly id: string;
  readonly provider: MetaMaskProvider;
}

export function discoverMetaMask(target: EventTarget, onProvider: (announcement: MetaMaskAnnouncement) => void): () => void {
  const receive = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (!detail || typeof detail !== 'object' || !('provider' in detail) || !isMetaMaskProvider(detail.provider) ||
      !('info' in detail) || !detail.info || typeof detail.info !== 'object' ||
      !('rdns' in detail.info) || detail.info.rdns !== 'io.metamask' ||
      !('uuid' in detail.info) || typeof detail.info.uuid !== 'string'
    ) return;
    onProvider({ id: detail.info.uuid, provider: detail.provider });
  };

  target.addEventListener('eip6963:announceProvider', receive);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => { target.removeEventListener('eip6963:announceProvider', receive); };
}

export function createMetaMaskDeepLink(target: URL): string {
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
    throw new WalletAuthError('invalid-challenge');
  }
  return `https://link.metamask.io/dapp/${target.host}${target.pathname}${target.search}`;
}
