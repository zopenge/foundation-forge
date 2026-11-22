# @openge/forge-payment-verification-evm

An explicit EVM verifier for top-level native-asset value transfers with a 32-byte payment reference in the transaction input.

```ts
import { createEvmNativePaymentVerifier } from '@openge/forge-payment-verification-evm';
import type { EvmPaymentRpcRequest } from '@openge/forge-payment-verification-evm';
import type { PaymentVerificationRequest } from '@openge/forge-payment-verification';

export function makeVerifier(rpc: (request: EvmPaymentRpcRequest) => Promise<unknown>) {
  const verifier = createEvmNativePaymentVerifier({ rpc });
  return (payment: PaymentVerificationRequest, signal: AbortSignal) => verifier.verify(payment, { signal });
}
```

Provide a trusted, chain-specific RPC transport. The injected function receives `method`, `params` and an optional `signal`, resolves to the raw JSON-RPC `result`, and rejects on a transport or JSON-RPC error. The application sets a deadline and propagates cancellation to the transport. The same verifier can retry after a transient failure or cancellation.

Use `eip155:<positive decimal chain ID>` for `network`, a 32-byte transaction hash, distinct nonzero 20-byte sender and recipient addresses, a positive decimal integer amount in the native asset’s smallest unit, and a 32-byte `0x`-prefixed hexadecimal reference. The entire transaction input must equal the reference. `minimumConfirmations` includes the mined block. Hex address, hash and reference evidence is lowercase. `blockNumber` and `confirmations` are decimal integer strings. The reported confirmation count is the proven minimum. Larger thresholds require additional RPC reads.

The verifier checks chain identity, transaction fields, receipt status and canonical block membership through the supplied RPC. It follows parent hashes from the canonical block at the required confirmation height back to the payment block. Evidence reflects an observation and carries the matching payment block hash. Choose confirmation depth and reorg handling for the receiving application. Supported evidence covers the transaction’s top-level `value` and `to` fields. Token transfers, internal transfers and recipient balances require a separate verification policy.
