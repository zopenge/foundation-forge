import {
  createLibp2pBrowserPeerNetworkProvider,
} from '../src/browser.js';
import { createLibp2pNodePeerNetworkProvider } from '../src/node.js';
import { verifyPeerNetworkProviderConformance } from './provider-conformance.js';

verifyPeerNetworkProviderConformance(
  'libp2p browser',
  () => createLibp2pBrowserPeerNetworkProvider({ listen: [] }),
);

verifyPeerNetworkProviderConformance(
  'libp2p node',
  () => createLibp2pNodePeerNetworkProvider(),
);
