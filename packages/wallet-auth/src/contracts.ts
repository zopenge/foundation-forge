export interface WalletAccount {
  readonly namespace: string;
  readonly network: string;
  readonly address: string;
}

export type WalletAuthPurpose = 'sign-in' | 'link';

export interface WalletChallenge {
  readonly id: string;
  readonly purpose: WalletAuthPurpose;
  readonly audience: string;
  readonly uri: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly account: WalletAccount;
}

export interface WalletSigningRequest {
  readonly challenge: WalletChallenge;
  readonly message: string;
}

export interface WalletProof {
  readonly challengeId: string;
  readonly message: string;
  readonly signature: string;
}

export type WalletAuthErrorCode =
  | 'invalid-challenge'
  | 'expired'
  | 'challenge-mismatch'
  | 'invalid-signature'
  | 'verification-unavailable'
  | 'account-changed'
  | 'cancelled'
  | 'wallet-rejected'
  | 'wallet-unavailable';

export type WalletChallengeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'invalid-challenge' | 'expired' };

export type WalletVerificationResult =
  | { readonly ok: true; readonly account: WalletAccount }
  | { readonly ok: false; readonly code: 'invalid-challenge' | 'expired' | 'challenge-mismatch' | 'invalid-signature' | 'verification-unavailable' };

export interface WalletConnector {
  connect(): Promise<WalletAccount>;
  sign(request: WalletSigningRequest, signal?: AbortSignal): Promise<WalletProof>;
}

export class WalletAuthError extends Error {
  override readonly name = 'WalletAuthError';

  constructor(readonly code: WalletAuthErrorCode) {
    super(code);
  }
}
