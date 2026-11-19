# MetaMask browser adapter

Use the explicit browser export:

```ts
import { createMetaMaskWallet, discoverMetaMask } from '@openge/forge-wallet-auth-metamask/browser';
```

Call `discoverMetaMask(window, onProvider)` to subscribe to wallet announcements. Dispose the returned subscription when the wallet picker closes. Once the user selects a provider, call `createMetaMaskWallet(provider).connect()`. Ask your product server for a challenge for the selected account, then call `wallet.sign({ challenge, message })`. Pass the proof to the product server for verification. An optional `AbortSignal` cancels waiting and releases the adapter's listeners. The wallet controls its own prompt.

For a mobile handoff, use `createMetaMaskDeepLink()` with a trusted HTTPS URL that contains only the public handoff identifier. The initiating browser holds the session-bound redemption credential. The product owns the QR code, expiry, user confirmation and one-time delivery of the result.
