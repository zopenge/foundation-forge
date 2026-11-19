import { encodeFunctionData, getAddress, isAddress } from 'viem';
import type { ContractWalletVerifier } from './siwe.js';

const abi = [{
  type: 'function',
  name: 'isValidSignature',
  stateMutability: 'view',
  inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }],
  outputs: [{ name: 'magicValue', type: 'bytes4' }]
}] as const;

const success = /^0x1626ba7e(?:0{56})?$/iu;

export interface EvmReadCall {
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
}

export type EvmReadTransport = (request: EvmReadCall) => Promise<string>;

export function createErc1271Verifier(readContract: EvmReadTransport): ContractWalletVerifier {
  return async ({ account, messageHash, signature }) => {
    const chainId = Number(account.network);
    if (account.namespace !== 'eip155' || !/^[1-9]\d*$/u.test(account.network) || !Number.isSafeInteger(chainId) ||
      !isAddress(account.address) || !/^0x[0-9a-f]{64}$/iu.test(messageHash) ||
      !/^0x(?:[0-9a-f]{2}){1,8192}$/iu.test(signature)) return false;

    const data = encodeFunctionData({
      abi, functionName: 'isValidSignature',
      args: [`0x${messageHash.slice(2)}`, `0x${signature.slice(2)}`]
    });
    const result = await readContract({ chainId, to: getAddress(account.address), data });
    return typeof result === 'string' && success.test(result);
  };
}
