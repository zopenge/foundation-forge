import type {
  ArtifactActivationPlan, ArtifactObjectDescriptor, ArtifactObjectReceipt, ArtifactPublicationOptions,
  ArtifactPublicationReceipt, ArtifactPublicationTarget,
} from './contracts.js';

export const describeObject = (value: ArtifactObjectDescriptor): ArtifactObjectDescriptor => ({
  key: value.key,
  byteLength: value.byteLength,
  sha256: value.sha256,
  contentType: value.contentType,
  cacheControl: value.cacheControl,
});

export type ObjectReceiptDraft = { -readonly [Key in keyof ArtifactObjectReceipt]: ArtifactObjectReceipt[Key] };

export const objectReceipt = (value: ArtifactObjectDescriptor): ObjectReceiptDraft => ({
  ...describeObject(value),
  writeState: 'not-attempted',
  verificationState: 'pending',
});

export type ReceiptDraft = Omit<{
  -readonly [Key in keyof ArtifactPublicationReceipt]: ArtifactPublicationReceipt[Key]
}, 'objects' | 'pointer'> & {
  objects: ObjectReceiptDraft[];
  pointer: ObjectReceiptDraft;
};

export const createReceipt = (target: ArtifactPublicationTarget, plan: ArtifactActivationPlan,
  options: ArtifactPublicationOptions, operation: 'publish' | 'activate'): ReceiptDraft => ({
  schemaVersion: 1,
  operation,
  outcome: 'failed',
  target,
  sourceCommit: plan.sourceCommit,
  immutablePrefix: plan.immutablePrefix,
  concurrencyControl: options.concurrencyControl,
  objects: plan.objects.map(objectReceipt),
  pointer: objectReceipt(plan.pointer),
  closure: { status: 'unconfirmed', activeRequests: 0 },
});
