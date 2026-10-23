import { createHash } from 'node:crypto';
import type {
  ArtifactBytes, ArtifactPublicationTransport, ArtifactTransportClosure,
} from '../src/index.js';

export const object = (key: string, text: string) => ({
  key,
  bytes: new TextEncoder().encode(text),
  byteLength: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex'),
  contentType: 'application/octet-stream',
  cacheControl: 'public,max-age=31536000,immutable',
});

export const plan = () => {
  const objects: [ReturnType<typeof object>, ...Array<ReturnType<typeof object>>] = [
    object('releases/a/one.bin', 'one'), object('releases/a/two.bin', 'two'),
  ];
  return {
    sourceCommit: 'a'.repeat(40),
    immutablePrefix: 'releases/a/',
    objects,
    pointer: { ...object('current.json', '{"release":"a"}'), contentType: 'application/json', cacheControl: 'no-store' },
  };
};

export const options = {
  concurrency: 2,
  timeoutMilliseconds: 2_000,
  closeTimeoutMilliseconds: 100,
  maxObjectBytes: 1_024,
  maxTotalBytes: 4_096,
  maxPointerBytes: 256,
  concurrencyControl: { mode: 'external-serialization' as const, scope: 'test-publication' },
};

export class MemoryTransport implements ArtifactPublicationTransport {
  readonly target = { provider: 'memory', namespace: 'fixture', endpoint: 'https://objects.example.test' };
  readonly objects = new Map<string, ArtifactBytes>();
  readonly events: string[] = [];
  closed = false;

  async prepare() { this.events.push('prepare'); }

  async createObject(value: ArtifactBytes) {
    this.events.push(`create:${value.key}`);
    if (this.objects.has(value.key)) return 'exists' as const;
    this.objects.set(value.key, { ...value, bytes: Uint8Array.from(value.bytes) });
    return 'created' as const;
  }

  async readObject({ key }: { key: string; maxBytes: number }) {
    this.events.push(`read:${key}`);
    const value = this.objects.get(key);
    if (!value) throw new Error('missing object');
    return { bytes: Uint8Array.from(value.bytes), contentType: value.contentType, cacheControl: value.cacheControl };
  }

  async replaceObject(value: ArtifactBytes) {
    this.events.push(`replace:${value.key}`);
    this.objects.set(value.key, { ...value, bytes: Uint8Array.from(value.bytes) });
  }

  async close(): Promise<ArtifactTransportClosure> {
    this.events.push('close');
    this.closed = true;
    return { status: 'closed', activeRequests: 0 };
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
