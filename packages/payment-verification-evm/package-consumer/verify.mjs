import assert from 'node:assert/strict';
import { createEvmNativePaymentVerifier } from '@openge/forge-payment-verification-evm';

const transactionId = `0x${'12'.repeat(32)}`;
const blockHash = `0x${'34'.repeat(32)}`;
const secondHash = `0x${'45'.repeat(32)}`;
const thirdHash = `0x${'67'.repeat(32)}`;
const sender = `0x${'56'.repeat(20)}`;
const recipient = `0x${'78'.repeat(20)}`;
const reference = `0x${'9a'.repeat(32)}`;
const anchor = { from: sender, to: recipient, blockHash, blockNumber: '0x1', transactionIndex: '0x0' };
const responses = {
  eth_chainId: '0x7a69',
  eth_getTransactionByHash: { ...anchor, hash: transactionId, input: reference, value: '0x2' },
  eth_getTransactionReceipt: { ...anchor, transactionHash: transactionId, status: '0x1' },
};
const verifier = createEvmNativePaymentVerifier({ rpc: async ({ method, params }) => {
  if (method === 'eth_getBlockByNumber') {
    if (params[0] === '0x3') return { hash: thirdHash, number: '0x3', parentHash: secondHash };
    return { hash: blockHash, number: '0x1', parentHash: `0x${'00'.repeat(32)}`, transactions: [transactionId] };
  }
  if (method === 'eth_getBlockByHash' && params[0] === secondHash) return { hash: secondHash, number: '0x2', parentHash: blockHash };
  return responses[method];
} });
const request = { transactionId, network: 'eip155:31337', sender, recipient, reference, amountAtomic: '2', minimumConfirmations: 3 };

assert.deepEqual(await verifier.verify(request), { status: 'verified', evidence: {
  transactionId, network: request.network, sender, recipient, reference, amountAtomic: '2', blockHash,
  blockNumber: '1', confirmations: '3',
} });
assert.deepEqual(await verifier.verify({ ...request, amountAtomic: '3' }), { status: 'rejected', reason: 'amount-mismatch' });
