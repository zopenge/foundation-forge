# @openge/forge-payment-verification

Provider-neutral TypeScript contracts for verifying payment evidence. A consumer supplies a `PaymentVerifier` and the trusted payment expectations. `verify(request, { signal })` returns a promise for one of four outcomes.

| Status | Meaning |
| --- | --- |
| `verified` | The verifier observed a matching payment and returned its evidence. |
| `pending` | The verifier has yet to observe enough evidence. |
| `rejected` | The request or observed payment fails verification. |
| `unavailable` | Verification could not complete. |

`PaymentVerificationRequest` contains `transactionId`, `network`, `sender`, `recipient`, `amountAtomic`, `reference`, and `minimumConfirmations`. Use the same unit on both sides of the payment. `isPositiveAtomicAmount` validates a positive, unpadded decimal integer string without converting it to a JavaScript number. Use this format for `amountAtomic`. A verification policy supplies `minimumConfirmations` as a positive safe integer. The provider interprets network, addresses, transaction identifier and reference according to its protocol.

Applications own retries, payment reuse prevention, order state and accounting. Reconcile those decisions against the evidence from a `verified` result.
