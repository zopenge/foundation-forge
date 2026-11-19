import { URL } from 'node:url';

import { createMetaMaskDeepLink } from '@openge/forge-wallet-auth-metamask/browser';

const link = createMetaMaskDeepLink(new URL('https://wallet.example/connect/opaque-id'));
if (link !== 'https://link.metamask.io/dapp/wallet.example/connect/opaque-id') {
  throw new Error('Installed MetaMask browser export did not produce the expected handoff link');
}
