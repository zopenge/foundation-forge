import type { ArtifactOperationBinding, ArtifactOperationOptions, ArtifactOperationRecord,
  ArtifactOperationObserver } from './contracts.js';
import { operationCode, operationReference, snapshotOperationBinding } from './binding.js';
import { ArtifactOperationError } from './errors.js';
import { snapshotTarget } from '../validation.js';

export function operationOptions(input: ArtifactOperationOptions): ArtifactOperationOptions {
  const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
  if (!input || !positive(input.timeoutMilliseconds) || !positive(input.closeTimeoutMilliseconds)
    || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw new ArtifactOperationError('INVALID_OPTIONS');
  return { timeoutMilliseconds: input.timeoutMilliseconds, closeTimeoutMilliseconds: input.closeTimeoutMilliseconds,
    ...(input.signal ? { signal: input.signal } : {}) };
}

export function requireOperationTarget(transport: ArtifactOperationObserver, binding: ArtifactOperationBinding): void {
  let target;
  try { target = snapshotTarget(transport.target); }
  catch { throw new ArtifactOperationError('TARGET_MISMATCH'); }
  if (JSON.stringify(target) !== JSON.stringify(binding.target)) throw new ArtifactOperationError('TARGET_MISMATCH');
  if (transport.capability !== binding.capability) throw new ArtifactOperationError('CAPABILITY_UNSUPPORTED');
  if (transport.configurationSha256 !== binding.configurationSha256) throw new ArtifactOperationError('BINDING_MISMATCH');
}

export const observationStates = ['absent', 'pending', 'succeeded', 'failed', 'unknown'] as const;

export async function snapshotOperationRecord(value: ArtifactOperationRecord, binding: ArtifactOperationBinding): Promise<ArtifactOperationRecord> {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || value.revision >= Number.MAX_SAFE_INTEGER || !['unknown', 'accepted', 'rejected'].includes(value.writeState)
    || !observationStates.includes(value.observation) || (value.reference !== undefined && !operationReference(value.reference))
    || (value.attemptFailure !== undefined && !operationCode(value.attemptFailure))) throw new ArtifactOperationError('INVALID_JOURNAL');
  const savedBinding = await snapshotOperationBinding(value.binding);
  if (savedBinding.fingerprint !== binding.fingerprint) throw new ArtifactOperationError('BINDING_MISMATCH');
  return Object.freeze({ schemaVersion: 1, revision: value.revision, binding: savedBinding,
    writeState: value.writeState, observation: value.observation,
    ...(value.reference !== undefined ? { reference: value.reference } : {}),
    ...(value.attemptFailure !== undefined ? { attemptFailure: value.attemptFailure } : {}) });
}
