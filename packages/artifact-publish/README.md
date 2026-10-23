# @openge/forge-artifact-publish

Provider-neutral publication of immutable objects, byte verification, and last-step pointer activation.

## Entries

- `@openge/forge-artifact-publish`: `publishArtifactRelease`, `activateArtifactRelease`, contracts, and `ArtifactPublicationError`. No Node-only imports.
- `@openge/forge-artifact-publish/node`: `publishArtifactFiles` and file-plan types. Node.js 22.14+; excluded from browser resolution.

An explicit Provider supplies storage; Core never selects one or reads credentials from the environment.

## Use

```ts
import { publishArtifactRelease } from '@openge/forge-artifact-publish';

const receipt = await publishArtifactRelease(transport, {
  sourceCommit, // Full lowercase Git SHA, 40 or 64 hex characters.
  immutablePrefix: `versions/${releaseId}/`,
  objects: [{
    key: `versions/${releaseId}/bundle.bin`, bytes, byteLength: bytes.byteLength,
    sha256, // Raw 64-character hex digest, without a "sha256:" prefix.
    contentType: 'application/octet-stream',
    cacheControl: 'public, max-age=31536000, immutable',
  }],
  pointer: {
    key: 'current.json', bytes: pointerBytes, byteLength: pointerBytes.byteLength,
    sha256: pointerSha256, contentType: 'application/json', cacheControl: 'no-cache',
  },
}, {
  concurrency: 4, timeoutMilliseconds: 600_000, closeTimeoutMilliseconds: 5_000,
  maxObjectBytes: 32 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024,
  maxPointerBytes: 64 * 1024,
  concurrencyControl: { mode: 'external-serialization', scope: 'artifact-channel' },
  signal,
});
```

The caller must serialize every writer for the pointer, including activation/rollback, through a single CI repository or an equivalent external coordinator. The scope is a recorded assertion, not a lock or compare-and-swap.

Local bytes are snapshotted and validated before storage writes. Existing objects are reused only when actual remote bytes, SHA-256, length, Content-Type, and Cache-Control match. After every object verifies, the pointer is replaced and read back. A successful receipt also requires confirmed resource closure.

`activateArtifactRelease(transport, plan, options)` takes the same plan with object descriptors instead of bytes. It verifies existing objects and replaces only the pointer. It does not upload missing objects. Pointer contents, signatures, trust policy, version ordering, and source provenance remain the caller's responsibility; the receipt records the supplied commit without proving it.

## Files and ownership

`publishArtifactFiles(transport, absoluteRoot, filePlan, options)` replaces each object's `bytes` with a portable relative `path`, and requires `pathCaseSensitivity: 'case-sensitive' | 'case-insensitive'`. It rejects symlinks, non-regular files, escapes, and case collisions; checks handle identity; reads bounded snapshots; and closes handles before network publication. The source tree must not be concurrently modified by an untrusted process. Path checks are not an operating-system sandbox.

Each operation owns a fresh transport and closes it on every outcome, including validation failures. Concurrent or later reuse is rejected. A transport must honor cancellation, bound reads, implement create-only writes, and report actual closure. The total budget covers preparation and transfers; the separate close-only budget waits for already-started work. Non-cooperative I/O can leave closure `unconfirmed`.

## Limits and failures

All limits are required. `maxTotalBytes` counts logical object bytes plus pointer bytes, not repeated network traffic or process memory. Buffered snapshots and concurrent responses require additional copies. Choose limits below the process memory allowance; this version has no streaming or multipart uploads.

Hard limits: 1–10,000 objects, concurrency 1–64, pointer limit at most 1 MiB, keys at most 1,024 UTF-8 bytes, and each timeout at most 2,147,483,647 ms. Keys follow portable relative-path rules; the pointer lies outside the immutable prefix. Headers are explicit printable ASCII values.

`ArtifactPublicationError` supplies stable `code`, `phase`, optional `key`/`statusCode`, `closure`, and a `receipt` when validation progressed far enough. Receipts contain descriptors and stage evidence, never credentials or object bytes. Keep secrets out of caller-supplied keys, scope, and target metadata, which are intentionally recorded. An `unknown` write may have reached storage; even a failed operation can have changed the pointer. Reconcile under the same external serialization before proceeding. There are no automatic retries or rollbacks.

See the [maintenance guide](../../docs/packages/artifacts/artifact-publish.md) for details.
