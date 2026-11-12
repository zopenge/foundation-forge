import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { snapshotArtifactIdentity } from '../content-identity.js';
import { snapshotTarget } from '../validation.js';
import type { ArtifactOperationBinding, ArtifactOperationIntent } from './contracts.js';
import { ArtifactOperationError } from './errors.js';

export const operationCapabilities = ['artifact-upload', 'deployment-create', 'deployment-ready', 'activation'] as const;
export const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const operationCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(value);
export const operationReference = (value: unknown): value is string => typeof value === 'string'
  && /^[\x21-\x7e]{1,512}$/u.test(value);

export async function bindArtifactOperation(input: ArtifactOperationIntent): Promise<ArtifactOperationBinding> {
  if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.requestId)
    || !operationCapabilities.includes(input.capability) || !sha256(input.configurationSha256)
    || !Array.isArray(input.inputs) || input.inputs.length < 1 || input.inputs.length > 1_024) {
    throw new ArtifactOperationError('INVALID_BINDING');
  }
  let target;
  let identity;
  try { target = Object.freeze(snapshotTarget(input.target)); identity = snapshotArtifactIdentity(input); }
  catch { throw new ArtifactOperationError('INVALID_BINDING'); }
  const names = new Set<string>();
  let totalBytes = 0;
  const inputs = Array.from(input.inputs, value => {
    if (!value || typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value.name)
      || names.has(value.name) || !sha256(value.sha256) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
      throw new ArtifactOperationError('INVALID_BINDING');
    }
    names.add(value.name);
    totalBytes += value.byteLength;
    if (!Number.isSafeInteger(totalBytes)) throw new ArtifactOperationError('INVALID_BINDING');
    return Object.freeze({ name: value.name, sha256: value.sha256, byteLength: value.byteLength });
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const intent = { requestId: input.requestId, ...identity, target,
    capability: input.capability, configurationSha256: input.configurationSha256, inputs: Object.freeze(inputs) };
  const fingerprint = (await calculateBytesIntegrity(new TextEncoder().encode(JSON.stringify(intent)))).sha256;
  return Object.freeze({ ...intent, fingerprint });
}

export async function snapshotOperationBinding(input: ArtifactOperationBinding): Promise<ArtifactOperationBinding> {
  const binding = await bindArtifactOperation(input);
  if (binding.fingerprint !== input.fingerprint) throw new ArtifactOperationError('BINDING_MISMATCH');
  return binding;
}
