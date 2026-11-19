import {
  WalletAuthError, validateWalletChallenge,
  type WalletAccount, type WalletChallenge, type WalletProof, type WalletVerificationResult
} from '@openge/forge-wallet-auth';
import { compactSignatureToSignature, getAddress, hashMessage, isAddress, recoverMessageAddress } from 'viem';
import { createSiweMessage } from 'viem/siwe';

export interface ContractWalletSignature {
  readonly account: WalletAccount;
  readonly messageHash: string;
  readonly signature: string;
}

export type ContractWalletVerifier = (request: ContractWalletSignature) => Promise<boolean>;

export interface VerifyEvmWalletProofOptions {
  readonly challenge: WalletChallenge;
  readonly proof: WalletProof;
  readonly now: Date;
  readonly verifyContractSignature?: ContractWalletVerifier;
}

export function createEvmWalletMessage(challenge: WalletChallenge): string {
  const status = validateWalletChallenge(challenge, new Date(challenge?.issuedAt));
  if (!status.ok) throw new WalletAuthError('invalid-challenge');
  const chainId = Number(challenge.account.network);
  const address = challenge.account.address;
  if (challenge.account.namespace !== 'eip155' || !/^[1-9]\d*$/u.test(challenge.account.network) ||
    !Number.isSafeInteger(chainId) || !isAddress(address)) {
    throw new WalletAuthError('invalid-challenge');
  }

  const audience = new URL(challenge.audience);
  try {
    return createSiweMessage({
      address: getAddress(address),
      chainId,
      scheme: audience.protocol.slice(0, -1),
      domain: audience.host,
      uri: challenge.uri,
      version: '1',
      nonce: challenge.nonce,
      requestId: challenge.id,
      statement: challenge.purpose === 'link' ? 'Link this wallet to your account.' : 'Sign in with this wallet.',
      issuedAt: new Date(challenge.issuedAt),
      expirationTime: new Date(challenge.expiresAt)
    });
  } catch {
    throw new WalletAuthError('invalid-challenge');
  }
}

export async function verifyEvmWalletProof({
  challenge, proof, now, verifyContractSignature
}: VerifyEvmWalletProofOptions): Promise<WalletVerificationResult> {
  const status = validateWalletChallenge(challenge, now);
  if (!status.ok) return status;

  let message: string;
  try {
    message = createEvmWalletMessage(challenge);
  } catch {
    return { ok: false, code: 'invalid-challenge' };
  }
  if (proof?.challengeId !== challenge.id || proof.message !== message) {
    return { ok: false, code: 'challenge-mismatch' };
  }

  const signature = proof.signature;
  if (typeof signature !== 'string' || !signature.startsWith('0x') || !/^0x(?:[0-9a-f]{2}){1,8192}$/iu.test(signature)) {
    return { ok: false, code: 'invalid-signature' };
  }
  const account: WalletAccount = Object.freeze({ ...challenge.account, address: challenge.account.address.toLowerCase() });

  if (verifyContractSignature !== undefined) {
    try {
      if ((await verifyContractSignature({ account, messageHash: hashMessage(message), signature })) === true) return { ok: true, account };
    } catch {
      return { ok: false, code: 'verification-unavailable' };
    }
  } else if (signature.length === 132 || signature.length === 130) {
    try {
      const recoverable = signature.length === 130 ? compactSignatureToSignature({
        r: `0x${signature.slice(2, 66)}`,
        yParityAndS: `0x${signature.slice(66)}`
      }) : `0x${signature.slice(2)}` as const;
      const signer = await recoverMessageAddress({ message, signature: recoverable });
      if (signer.toLowerCase() === account.address) return { ok: true, account };
    } catch {
      return { ok: false, code: 'invalid-signature' };
    }
  }
  return { ok: false, code: 'invalid-signature' };
}
