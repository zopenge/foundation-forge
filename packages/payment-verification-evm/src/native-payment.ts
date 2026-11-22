import { isPositiveAtomicAmount } from '@openge/forge-payment-verification';
import type { PaymentVerificationRequest, PaymentVerificationResult, PaymentVerifier } from '@openge/forge-payment-verification';
import { checkConfirmations } from './confirmations.js';
import type { EvmNativePaymentEvidence, EvmNativePaymentVerifierOptions } from './contracts.js';
import { hexAddress, hexWord, isRecord, maxUint256 } from './evm-values.js';
import { InvalidRpcResponse, readBlock, readQuantity, readReceipt, readTransaction } from './rpc-response.js';

const zeroAddress = `0x${'0'.repeat(40)}`;
const aborted = Object.freeze({ status: 'unavailable', reason: 'aborted' } as const);

function normalizeRequest(request: PaymentVerificationRequest) {
  if (!isRecord(request)) return;
  const { network, amountAtomic, minimumConfirmations } = request;
  const transactionId = hexWord(request.transactionId);
  const sender = hexAddress(request.sender);
  const recipient = hexAddress(request.recipient);
  const reference = hexWord(request.reference);
  const chain = typeof network === 'string' ? /^eip155:([1-9][0-9]{0,31})$/u.exec(network)?.[1] : undefined;
  if (!chain || !transactionId || !sender || !recipient || !reference || sender === zeroAddress || recipient === zeroAddress
    || sender === recipient || !isPositiveAtomicAmount(amountAtomic) || amountAtomic.length > 78
    || !Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1) return;
  const amount = BigInt(amountAtomic);
  if (amount > maxUint256) return;
  return { transactionId, network, sender, recipient, reference, amountAtomic, amount,
    chainId: BigInt(chain), minimumConfirmations: BigInt(minimumConfirmations) };
}

type Result = PaymentVerificationResult<EvmNativePaymentEvidence>;

async function inspectPayment(request: PaymentVerificationRequest, rpc: EvmNativePaymentVerifierOptions['rpc'],
  signal: AbortSignal | undefined): Promise<Result> {
  const call: typeof rpc = async query => {
    signal?.throwIfAborted();
    const result = await rpc(signal ? { ...query, signal } : query);
    signal?.throwIfAborted();
    return result;
  };

  try {
    const payment = normalizeRequest(request);
    if (!payment) return { status: 'rejected', reason: 'invalid-request' };
    const { transactionId, network, sender, recipient, reference, amountAtomic, amount, chainId, minimumConfirmations } = payment;
    const readChain = async () => readQuantity(await call({ method: 'eth_chainId', params: [] }));
    if (await readChain() !== chainId) return { status: 'rejected', reason: 'network-mismatch' };

    const rawTransaction = await call({ method: 'eth_getTransactionByHash', params: [transactionId] });
    if (rawTransaction === null) return { status: 'pending', reason: 'transaction-not-found' };
    const transaction = readTransaction(rawTransaction, transactionId);
    if (transaction.chainId !== undefined && transaction.chainId !== chainId) return { status: 'rejected', reason: 'network-mismatch' };
    if (transaction.sender !== sender) return { status: 'rejected', reason: 'sender-mismatch' };
    if (transaction.recipient !== recipient) return { status: 'rejected', reason: 'recipient-mismatch' };
    if (transaction.amount !== amount) return { status: 'rejected', reason: 'amount-mismatch' };
    if (transaction.input !== reference) return { status: 'rejected', reason: 'reference-mismatch' };
    if (transaction.location === null) return { status: 'pending', reason: 'receipt-not-found' };

    const rawReceipt = await call({ method: 'eth_getTransactionReceipt', params: [transactionId] });
    if (rawReceipt === null) return { status: 'pending', reason: 'receipt-not-found' };
    const receipt = readReceipt(rawReceipt, transactionId);
    if (receipt.sender !== sender || receipt.recipient !== recipient) throw new InvalidRpcResponse();
    const { hash, number, index } = receipt.location;
    if (hash !== transaction.location.hash || number !== transaction.location.number || index !== transaction.location.index) {
      return { status: 'pending', reason: 'noncanonical-block' };
    }

    const rawBlock = await call({ method: 'eth_getBlockByNumber', params: [`0x${number.toString(16)}`, false] });
    if (rawBlock === null) return { status: 'pending', reason: 'noncanonical-block' };
    const block = readBlock(rawBlock);
    if (block.hash !== hash || block.number !== number || index >= BigInt(block.transactionIds.length)
      || block.transactionIds[Number(index)] !== transactionId) return { status: 'pending', reason: 'noncanonical-block' };
    const confirmationIssue = await checkConfirmations(call, block, minimumConfirmations);
    if (confirmationIssue) return { status: 'pending', reason: confirmationIssue };
    if (await readChain() !== chainId) return { status: 'unavailable', reason: 'chain-changed' };

    if (!receipt.succeeded) return { status: 'rejected', reason: 'transaction-reverted' };
    return { status: 'verified', evidence: { transactionId, network, sender, recipient, reference, amountAtomic,
      blockHash: hash, blockNumber: number.toString(), confirmations: minimumConfirmations.toString() } };
  } catch (error) {
    if (signal?.aborted) return aborted;
    return { status: 'unavailable', reason: error instanceof InvalidRpcResponse ? 'invalid-rpc-response' : 'rpc-unavailable' };
  }
}

export function createEvmNativePaymentVerifier({ rpc }: EvmNativePaymentVerifierOptions): PaymentVerifier<EvmNativePaymentEvidence> {
  return {
    async verify(request, options) {
      if (!options?.signal) return inspectPayment(request, rpc, undefined);
      const signal = AbortSignal.any([options.signal]);
      if (signal.aborted) return aborted;
      let onAbort: (() => void) | undefined;
      const cancellation = new Promise<Result>(resolve => {
        onAbort = () => resolve(aborted);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([inspectPayment(request, rpc, signal), cancellation]);
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
