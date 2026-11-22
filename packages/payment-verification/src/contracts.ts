export interface PaymentVerificationRequest {
  readonly transactionId: string;
  readonly network: string;
  readonly sender: string;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly reference: string;
  readonly minimumConfirmations: number;
}

export interface PaymentVerificationEvidence {
  readonly transactionId: string;
  readonly network: string;
  readonly sender: string;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly reference: string;
}

export type PaymentVerificationResult<Evidence extends PaymentVerificationEvidence = PaymentVerificationEvidence> =
  | { readonly status: 'verified'; readonly evidence: Evidence }
  | { readonly status: 'pending'; readonly reason: string }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface PaymentVerificationOptions {
  readonly signal?: AbortSignal;
}

export interface PaymentVerifier<Evidence extends PaymentVerificationEvidence = PaymentVerificationEvidence> {
  verify(request: PaymentVerificationRequest, options?: PaymentVerificationOptions): Promise<PaymentVerificationResult<Evidence>>;
}
