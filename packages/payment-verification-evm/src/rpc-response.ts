import { hexAddress, hexData, hexWord, isRecord } from './evm-values.js';

export class InvalidRpcResponse extends Error {}

export function readQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/iu.test(value)) throw new InvalidRpcResponse();
  return BigInt(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidRpcResponse();
  return value;
}

function readLocation(data: Record<string, unknown>) {
  const hash = hexWord(data.blockHash);
  if (hash === undefined) throw new InvalidRpcResponse();
  return { hash, number: readQuantity(data.blockNumber), index: readQuantity(data.transactionIndex) };
}

function readParties(data: Record<string, unknown>) {
  const sender = hexAddress(data.from);
  const recipient = data.to === null ? null : hexAddress(data.to);
  if (sender === undefined || recipient === undefined) throw new InvalidRpcResponse();
  return { sender, recipient };
}

export function readTransaction(value: unknown, expectedHash: string) {
  const data = readRecord(value);
  const input = hexData(data.input);
  if (hexWord(data.hash) !== expectedHash || input === undefined) throw new InvalidRpcResponse();
  return {
    ...readParties(data), input, amount: readQuantity(data.value),
    chainId: data.chainId === undefined ? undefined : readQuantity(data.chainId),
    location: data.blockHash === null && data.blockNumber === null && data.transactionIndex === null ? null : readLocation(data),
  };
}

export function readReceipt(value: unknown, expectedHash: string) {
  const data = readRecord(value);
  const status = readQuantity(data.status);
  if (hexWord(data.transactionHash) !== expectedHash || (status !== 0n && status !== 1n)) throw new InvalidRpcResponse();
  return { ...readParties(data), location: readLocation(data), succeeded: status === 1n };
}

export function readBlockHeader(value: unknown) {
  const data = readRecord(value);
  const hash = hexWord(data.hash);
  const parentHash = hexWord(data.parentHash);
  if (hash === undefined || parentHash === undefined) throw new InvalidRpcResponse();
  return { hash, parentHash, number: readQuantity(data.number) };
}

export function readBlock(value: unknown) {
  const data = readRecord(value);
  if (!Array.isArray(data.transactions)) throw new InvalidRpcResponse();
  const transactionIds = (data.transactions as unknown[]).map(value => {
    const id = hexWord(value);
    if (id === undefined) throw new InvalidRpcResponse();
    return id;
  });
  return { ...readBlockHeader(data), transactionIds };
}
