import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type {
  ArtifactActivationPlan, ArtifactBytes, ArtifactObjectDescriptor, ArtifactPublicationOptions,
  ArtifactPublicationTarget,
} from './contracts.js';
import { ArtifactPublicationError } from './errors.js';

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const hasControl = (value: string) => [...value].some(character => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
});

export function validateOptions(value: ArtifactPublicationOptions): ArtifactPublicationOptions {
  if (!value || !positiveInteger(value.concurrency) || value.concurrency > 64
    || !positiveInteger(value.timeoutMilliseconds) || value.timeoutMilliseconds > 2_147_483_647
    || !positiveInteger(value.closeTimeoutMilliseconds) || value.closeTimeoutMilliseconds > 2_147_483_647
    || !positiveInteger(value.maxObjectBytes) || !positiveInteger(value.maxTotalBytes)
    || !positiveInteger(value.maxPointerBytes) || value.maxPointerBytes > 1_048_576
    || value.concurrencyControl?.mode !== 'external-serialization'
    || typeof value.concurrencyControl.scope !== 'string' || !value.concurrencyControl.scope.trim()
    || value.concurrencyControl.scope.length > 256 || hasControl(value.concurrencyControl.scope)
    || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) {
    throw new ArtifactPublicationError('INVALID_OPTIONS');
  }
  return {
    concurrency: value.concurrency,
    timeoutMilliseconds: value.timeoutMilliseconds,
    closeTimeoutMilliseconds: value.closeTimeoutMilliseconds,
    maxObjectBytes: value.maxObjectBytes,
    maxTotalBytes: value.maxTotalBytes,
    maxPointerBytes: value.maxPointerBytes,
    concurrencyControl: { mode: 'external-serialization', scope: value.concurrencyControl.scope },
    ...(value.signal ? { signal: value.signal } : {}),
  };
}

export function snapshotTarget(value: ArtifactPublicationTarget): ArtifactPublicationTarget {
  if (!value || typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.provider)
    || typeof value.namespace !== 'string' || !value.namespace.trim() || value.namespace.length > 256
    || hasControl(value.namespace) || typeof value.endpoint !== 'string') {
    throw new ArtifactPublicationError('INVALID_TARGET');
  }
  let url: URL;
  try { url = new URL(value.endpoint); }
  catch { throw new ArtifactPublicationError('INVALID_TARGET'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ArtifactPublicationError('INVALID_TARGET');
  }
  return { provider: value.provider, namespace: value.namespace, endpoint: url.origin };
}

function objectKey(value: unknown): string {
  if (typeof value !== 'string' || hasControl(value) || new TextEncoder().encode(value).byteLength > 1_024) {
    throw new ArtifactPublicationError('INVALID_PLAN');
  }
  try { return validatePortableRelativePath(value); }
  catch { throw new ArtifactPublicationError('INVALID_PLAN'); }
}

function headerValue(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 2_048
    || [...value].some(character => { const code = character.charCodeAt(0); return code < 32 || code > 126; })) {
    throw new ArtifactPublicationError('INVALID_PLAN');
  }
  return value;
}

function descriptor(value: ArtifactObjectDescriptor, maxBytes: number): ArtifactObjectDescriptor {
  if (!value || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > maxBytes
    || typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(value.sha256)) {
    throw new ArtifactPublicationError('INVALID_PLAN');
  }
  return {
    key: objectKey(value.key), byteLength: value.byteLength, sha256: value.sha256.toLowerCase(),
    contentType: headerValue(value.contentType), cacheControl: headerValue(value.cacheControl),
  };
}

function snapshotBytes(value: ArtifactObjectDescriptor, expected: ArtifactObjectDescriptor): ArtifactBytes {
  if (!('bytes' in value) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== expected.byteLength) {
    throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
  }
  return { ...expected, bytes: Uint8Array.from(value.bytes) };
}

export function snapshotPlan(input: ArtifactActivationPlan, options: ArtifactPublicationOptions, operation: 'publish' | 'activate'): {
  plan: ArtifactActivationPlan;
  uploads: readonly ArtifactBytes[] | undefined;
} {
  if (!input || typeof input.sourceCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.sourceCommit)
    || typeof input.immutablePrefix !== 'string' || !input.immutablePrefix.endsWith('/')
    || !Array.isArray(input.objects) || input.objects.length === 0 || input.objects.length > 10_000) {
    throw new ArtifactPublicationError('INVALID_PLAN');
  }
  const prefix = `${objectKey(input.immutablePrefix.slice(0, -1))}/`;
  const objects = input.objects.map(value => descriptor(value, options.maxObjectBytes));
  const pointer = descriptor(input.pointer, options.maxPointerBytes);
  const keys = new Set<string>();
  let totalBytes = pointer.byteLength;
  for (const value of objects) {
    totalBytes += value.byteLength;
    if (!value.key.startsWith(prefix) || keys.has(value.key) || !Number.isSafeInteger(totalBytes)) {
      throw new ArtifactPublicationError('INVALID_PLAN');
    }
    keys.add(value.key);
  }
  if (totalBytes > options.maxTotalBytes || pointer.key.startsWith(prefix) || keys.has(pointer.key)) {
    throw new ArtifactPublicationError('INVALID_PLAN');
  }
  return {
    plan: {
      sourceCommit: input.sourceCommit, immutablePrefix: prefix, objects,
      pointer: snapshotBytes(input.pointer, pointer),
    },
    uploads: operation === 'publish' ? input.objects.map((value, index) => {
      const expected = objects[index];
      if (!expected) throw new ArtifactPublicationError('INVALID_PLAN');
      return snapshotBytes(value, expected);
    }) : undefined,
  };
}
