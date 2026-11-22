import { describe, expect, it, vi } from 'vitest';
import type { PaymentVerificationRequest } from '@openge/forge-payment-verification';
import { createEvmNativePaymentVerifier } from '../src/index.js';
import type { EvmPaymentRpcRequest } from '../src/index.js';

const transactionId = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'bc'.repeat(32)}`;
const otherBlockHash = `0x${'cd'.repeat(32)}`;
const confirmationHash = `0x${'de'.repeat(32)}`;
const sender = `0x${'ac'.repeat(20)}`;
const recipient = `0x${'bd'.repeat(20)}`;
const reference = `0x${'ce'.repeat(32)}`;
const amount = '9007199254740993123456789';
const network = 'eip155:31337';
const request: PaymentVerificationRequest = {
  transactionId, network, sender, recipient, reference, amountAtomic: amount, minimumConfirmations: 2,
};
const transaction = {
  hash: transactionId, from: sender, to: recipient, value: `0x${BigInt(amount).toString(16)}`,
  input: reference, blockHash, blockNumber: '0x10', transactionIndex: '0x1', chainId: '0x7a69',
};
const receipt = {
  transactionHash: transactionId, from: sender, to: recipient, blockHash, blockNumber: '0x10',
  transactionIndex: '0x1', status: '0x1',
};
const block = { hash: blockHash, number: '0x10', parentHash: otherBlockHash, transactions: [otherBlockHash, transactionId] };
const confirmation = { hash: confirmationHash, number: '0x11', parentHash: blockHash, transactions: [] };
const responses = {
  eth_chainId: '0x7a69', eth_getTransactionByHash: transaction,
  eth_getTransactionReceipt: receipt, eth_getBlockByNumber: block, eth_getBlockByHash: confirmation,
};
const defaultResponse = ({ method, params }: EvmPaymentRpcRequest) =>
  method === 'eth_getBlockByNumber' && params[0] === '0x11' ? confirmation : responses[method];
const fixture = (overrides: Partial<Record<EvmPaymentRpcRequest['method'], unknown>> = {}) => {
  const rpc = vi.fn(async (call: EvmPaymentRpcRequest) =>
    Object.hasOwn(overrides, call.method) ? overrides[call.method] : defaultResponse(call));
  return { rpc, verifier: createEvmNativePaymentVerifier({ rpc }) };
};

describe('EVM native payment verifier', () => {
  it('returns exact evidence after checking two confirmations and canonical membership', async () => {
    const { rpc, verifier } = fixture();
    const mixedCase = (value: string) => `0x${value.slice(2).toUpperCase()}`;
    await expect(verifier.verify({ ...request, sender: mixedCase(sender), recipient: mixedCase(recipient),
      transactionId: mixedCase(transactionId), reference: mixedCase(reference) })).resolves.toEqual({
      status: 'verified', evidence: { transactionId, network, sender, recipient, reference,
        amountAtomic: amount, blockHash, blockNumber: '16', confirmations: '2' },
    });
    expect(rpc.mock.calls.map(([{ method, params }]) => [method, params])).toEqual([
      ['eth_chainId', []], ['eth_getTransactionByHash', [transactionId]],
      ['eth_getTransactionReceipt', [transactionId]], ['eth_getBlockByNumber', ['0x10', false]],
      ['eth_getBlockByNumber', ['0x11', false]], ['eth_getBlockByNumber', ['0x11', false]], ['eth_chainId', []],
    ]);
  });

  it.each([
    { amountAtomic: '01' }, { amountAtomic: (2n ** 256n).toString() }, { sender: '0x12' },
    { recipient: `0x${'00'.repeat(20)}` }, { sender: recipient },
    { reference: `${reference}00` }, { transactionId: '0x12' }, { network: 'eip155:031337' },
    { minimumConfirmations: 0 }, { minimumConfirmations: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid expectations before RPC: %j', async invalid => {
    const { rpc, verifier } = fixture();
    await expect(verifier.verify({ ...request, ...invalid })).resolves.toEqual({ status: 'rejected', reason: 'invalid-request' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ from: recipient }, 'sender-mismatch'],
    [{ to: sender }, 'recipient-mismatch'],
    [{ to: null }, 'recipient-mismatch'],
    [{ value: `0x${(BigInt(amount) + 1n).toString(16)}` }, 'amount-mismatch'],
    [{ input: `${reference}00` }, 'reference-mismatch'],
    [{ input: `0x00${reference.slice(2)}` }, 'reference-mismatch'],
    [{ chainId: '0x1' }, 'network-mismatch'],
  ])('rejects a transaction with %j', async (change, reason) => {
    const { verifier } = fixture({ eth_getTransactionByHash: { ...transaction, ...change } });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'rejected', reason });
  });

  it('rejects a canonical revert', async () => {
    const { verifier } = fixture({ eth_getTransactionReceipt: { ...receipt, status: '0x0' } });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'rejected', reason: 'transaction-reverted' });
  });

  it('does not combine a canonical payment block with confirmations from a different fork', async () => {
    const verifier = createEvmNativePaymentVerifier({ rpc: async (call) => {
      if (call.method === 'eth_getBlockByNumber' && call.params[0] === '0x11') {
        return { ...confirmation, parentHash: otherBlockHash };
      }
      return defaultResponse(call);
    } });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'pending', reason: 'noncanonical-block' });
  });

  it('reports pending when the confirmation height has not been mined', async () => {
    const verifier = createEvmNativePaymentVerifier({ rpc: async (call) =>
      call.method === 'eth_getBlockByNumber' && call.params[0] === '0x11' ? null : defaultResponse(call) });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'pending', reason: 'insufficient-confirmations' });
  });

  it('walks the confirmation path by block hash to prove three confirmations', async () => {
    const rpc = vi.fn(async (call: EvmPaymentRpcRequest) =>
      call.method === 'eth_getBlockByNumber' && call.params[0] === '0x12'
        ? { hash: `0x${'ef'.repeat(32)}`, number: '0x12', parentHash: confirmationHash }
        : defaultResponse(call));
    const verifier = createEvmNativePaymentVerifier({ rpc });
    await expect(verifier.verify({ ...request, minimumConfirmations: 3 })).resolves.toMatchObject({
      status: 'verified', evidence: { confirmations: '3' },
    });
    expect(rpc).toHaveBeenCalledWith({ method: 'eth_getBlockByHash', params: [confirmationHash, false] });
  });

  it('reports pending if the canonical confirmation target changes while checking ancestry', async () => {
    let targetSeen = false;
    const verifier = createEvmNativePaymentVerifier({ rpc: async (call) => {
      if (call.method !== 'eth_getBlockByNumber' || call.params[0] !== '0x11') return defaultResponse(call);
      if (targetSeen) return { ...confirmation, hash: otherBlockHash };
      targetSeen = true;
      return confirmation;
    } });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'pending', reason: 'noncanonical-block' });
  });

  it('proves one confirmation from canonical inclusion alone', async () => {
    const { rpc, verifier } = fixture();
    await expect(verifier.verify({ ...request, minimumConfirmations: 1 })).resolves.toMatchObject({
      status: 'verified', evidence: { confirmations: '1' },
    });
    expect(rpc.mock.calls.filter(([{ method }]) => method === 'eth_getBlockByNumber')).toHaveLength(1);
  });

  it.each([
    [{ eth_getTransactionByHash: null }, 'transaction-not-found'],
    [{ eth_getTransactionReceipt: null }, 'receipt-not-found'],
    [{ eth_getTransactionByHash: { ...transaction, blockHash: null, blockNumber: null, transactionIndex: null } }, 'receipt-not-found'],
    [{ eth_getTransactionReceipt: { ...receipt, blockHash: otherBlockHash } }, 'noncanonical-block'],
    [{ eth_getBlockByNumber: null }, 'noncanonical-block'],
    [{ eth_getBlockByNumber: { ...block, hash: otherBlockHash } }, 'noncanonical-block'],
    [{ eth_getBlockByNumber: { ...block, transactions: [transactionId, otherBlockHash] } }, 'noncanonical-block'],
  ])('keeps an unsettled payment pending: %j', async (overrides, reason) => {
    const { verifier } = fixture(overrides);
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'pending', reason });
  });

  it.each([
    { eth_chainId: '0x07a69' }, { eth_getTransactionByHash: { ...transaction, hash: blockHash } },
    { eth_getTransactionByHash: { ...transaction, input: `${reference}a` } },
    { eth_getTransactionReceipt: { ...receipt, transactionHash: blockHash } },
    { eth_getTransactionReceipt: { ...receipt, from: recipient } },
    { eth_getTransactionReceipt: { ...receipt, status: '0x2' } },
    { eth_getBlockByNumber: { ...block, transactions: [otherBlockHash, transaction] } },
  ])('reports malformed or contradictory RPC data: %j', async overrides => {
    const { verifier } = fixture(overrides);
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'unavailable', reason: 'invalid-rpc-response' });
  });

  it('checks chain identity again before returning evidence', async () => {
    let seenChain = false;
    const verifier = createEvmNativePaymentVerifier({ rpc: async (call) => {
      if (call.method !== 'eth_chainId') return defaultResponse(call);
      if (seenChain) return '0x1';
      seenChain = true;
      return responses.eth_chainId;
    } });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'unavailable', reason: 'chain-changed' });
  });

  it('rejects the wrong initial chain without querying the transaction', async () => {
    const { rpc, verifier } = fixture({ eth_chainId: '0x1' });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'rejected', reason: 'network-mismatch' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('recovers on the next call in the same process when RPC becomes available', async () => {
    const rpc = vi.fn(async (call: EvmPaymentRpcRequest) => defaultResponse(call));
    rpc.mockRejectedValueOnce(new Error('private transport details'));
    const verifier = createEvmNativePaymentVerifier({ rpc });
    await expect(verifier.verify(request)).resolves.toEqual({ status: 'unavailable', reason: 'rpc-unavailable' });
    await expect(verifier.verify(request)).resolves.toMatchObject({ status: 'verified' });
  });

  it('cancels an in-flight request and accepts a new call on the same verifier', async () => {
    const controller = new AbortController();
    let finish: ((value: string) => void) | undefined;
    const firstRpc = new Promise<string>(resolve => { finish = resolve; });
    const rpc = vi.fn(async (call: EvmPaymentRpcRequest) => defaultResponse(call));
    rpc.mockImplementationOnce(() => firstRpc);
    const verifier = createEvmNativePaymentVerifier({ rpc });
    const inFlight = verifier.verify(request, { signal: controller.signal });
    const rpcSignal = rpc.mock.calls[0]?.[0].signal;
    expect(rpcSignal?.aborted).toBe(false);
    controller.abort();
    expect(rpcSignal?.aborted).toBe(true);
    await expect(inFlight).resolves.toEqual({ status: 'unavailable', reason: 'aborted' });
    finish?.(responses.eth_chainId);
    await expect(verifier.verify(request, { signal: controller.signal })).resolves.toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(verifier.verify(request)).resolves.toMatchObject({ status: 'verified' });
  });

  it('settles cancellation even when an earlier caller listener stops propagation', async () => {
    const controller = new AbortController();
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation(), { once: true });
    let finish: ((value: string) => void) | undefined;
    const pendingRpc = new Promise<string>(resolve => { finish = resolve; });
    const verifier = createEvmNativePaymentVerifier({ rpc: () => pendingRpc });
    const verification = verifier.verify(request, { signal: controller.signal });
    try {
      controller.abort();
      const nextTurn = new Promise(resolve => setImmediate(() => resolve('unsettled')));
      await expect(Promise.race([verification, nextTurn])).resolves.toEqual({ status: 'unavailable', reason: 'aborted' });
    } finally {
      finish?.('0x7a69');
      await verification;
    }
  });
});
