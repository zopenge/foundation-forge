import type { PaymentVerificationEvidence } from '@openge/forge-payment-verification';

export type EvmPaymentRpcRequest = (
  | { readonly method: 'eth_chainId'; readonly params: readonly [] }
  | { readonly method: 'eth_getTransactionByHash' | 'eth_getTransactionReceipt'; readonly params: readonly [string] }
  | { readonly method: 'eth_getBlockByNumber' | 'eth_getBlockByHash'; readonly params: readonly [string, false] }
) & { readonly signal?: AbortSignal };

export interface EvmNativePaymentVerifierOptions {
  readonly rpc: (request: EvmPaymentRpcRequest) => Promise<unknown>;
}

export interface EvmNativePaymentEvidence extends PaymentVerificationEvidence {
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly confirmations: string;
}
