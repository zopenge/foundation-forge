# @openge/forge-artifact-publish

Provider-neutral publication of immutable objects, byte verification, and last-step pointer activation.

## Entries

- `@openge/forge-artifact-publish`: object publication, content manifests, durable operation binding/execution/observation, contracts, and structured errors. No Node-only imports.
- `@openge/forge-artifact-publish/node`: `publishArtifactFiles`, `createCommandArtifactOperation`, and Node-specific types. Node.js 22.14+; excluded from browser resolution.

An explicit Provider supplies storage; Core never selects one or reads credentials from the environment.

## Use

```ts
import { publishArtifactRelease } from '@openge/forge-artifact-publish';

const receipt = await publishArtifactRelease(transport, {
  content: { manifestSha256 }, // SHA-256 of the actual content manifest bytes.
  // provenance: { gitRevision }, // Optional actual Git revision, never fabricated.
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

`activateArtifactRelease(transport, plan, options)` takes the same plan with object descriptors instead of bytes. It verifies existing objects and replaces only the pointer. It does not upload missing objects. Pointer contents, signatures, trust policy, version ordering, and source provenance remain the caller's responsibility; the receipt records declared content identity and optional provenance without authenticating their origin.

`createArtifactContentManifest({ schemaVersion: 1, files })` creates canonical UTF-8 manifest bytes and their SHA-256 content identity. Entries bind paths, lengths, digests, asset response headers and control files. The caller must verify actual payload bytes. See the [content identity contract](../../docs/packages/artifacts/artifact-content.md) for canonicalization, limits and migration.

## Files and ownership

`publishArtifactFiles(transport, absoluteRoot, filePlan, options)` replaces each object's `bytes` with a portable relative `path`, and requires `pathCaseSensitivity: 'case-sensitive' | 'case-insensitive'`. It rejects symlinks, non-regular files, escapes, and case collisions; checks handle identity; reads bounded snapshots; and closes handles before network publication. The source tree must not be concurrently modified by an untrusted process. Path checks are not an operating-system sandbox.

Each operation owns a fresh transport and closes it on every outcome, including validation failures. Concurrent or later reuse is rejected. A transport must honor cancellation, bound reads, implement create-only writes, and report actual closure. The total budget covers preparation and transfers; the separate close-only budget waits for already-started work. Non-cooperative I/O can leave closure `unconfirmed`.

## Limits and failures

All limits are required. `maxTotalBytes` counts logical object bytes plus pointer bytes, not repeated network traffic or process memory. Buffered snapshots and concurrent responses require additional copies. Choose limits below the process memory allowance; this version has no streaming or multipart uploads.

Hard limits: 1–10,000 objects, concurrency 1–64, pointer limit at most 1 MiB, keys at most 1,024 UTF-8 bytes, and each timeout at most 2,147,483,647 ms. Keys follow portable relative-path rules; the pointer lies outside the immutable prefix. Headers are explicit printable ASCII values.

`ArtifactPublicationError` supplies stable `code`, `phase`, optional `key`/`statusCode`, `closure`, and a `receipt` when validation progressed far enough. Receipts contain descriptors and stage evidence, never credentials or object bytes. Keep secrets out of caller-supplied keys, scope, and target metadata, which are intentionally recorded. An `unknown` write may have reached storage; even a failed operation can have changed the pointer. Reconcile under the same external serialization before proceeding. There are no automatic retries or rollbacks.

See the [maintenance guide](../../docs/packages/artifacts/artifact-publish.md) for details.

## Durable operations across explicit backends

`bindArtifactOperation`, `performArtifactOperation`, and `observeArtifactOperation`
also support a single backend operation independently of object storage. They bind
the request ID, target, content identity, optional Git provenance, capability, configuration digest, and sorted
artifact descriptors into a SHA-256 fingerprint. Supported facts are
`artifact-upload`, `deployment-create`, `deployment-ready`, and `activation`.
They are separate facts; an accepted upload never implies a ready deployment or
application registration.

Provide a fresh `ArtifactOperationTransport` and a journal implementing real
atomic `load` / `compareAndSet`. Execution starts only after a confirmed durable
claim with `writeState: 'unknown'`. Existing request IDs cannot execute again.
Recovery calls `observeArtifactOperation`, which never calls `execute`, including
when the remote resource is absent. Choose a new request only after explicitly
reconciling the previous attempt under consumer-owned coordination.
Recovery accepts an `ArtifactOperationObserver` without an `execute` method. Its
configuration digest identifies the original operation, even when an explicitly
configured observer uses a different host or rotated observation credentials.

```ts
import {
  bindArtifactOperation, performArtifactOperation, observeArtifactOperation,
} from '@openge/forge-artifact-publish';

const binding = await bindArtifactOperation({
  requestId: 'release-42-static', content: preparedManifest.content,
  target: adapter.target, capability: adapter.capability,
  configurationSha256: adapter.configurationSha256,
  inputs: [
    { name: 'static-tree', sha256: treeDigest, byteLength: treeBytes },
    { name: 'content-manifest.json', sha256: preparedManifest.content.manifestSha256,
      byteLength: preparedManifest.bytes.byteLength },
  ],
});
const limits = { timeoutMilliseconds: 300_000, closeTimeoutMilliseconds: 5_000 };
const receipt = await performArtifactOperation(adapter, binding, journal, limits);
// A later process uses the same binding and journal, with a fresh adapter:
const recovered = await observeArtifactOperation(freshAdapter, binding, journal, limits);
```

Each call observes once and can return `pending`. Later requests use a fresh observer with the same binding, durable journal and stable remote reference. Scheduling and application progress remain consumer-owned.

An adapter must independently verify remote target, identity, source and artifact
bytes/digests before returning `succeeded`; echoing a caller-supplied fingerprint
does not authenticate provenance. The journal serializes one request ID, not all
writers to a target. Cross-request coordination remains the consumer's job.
Journal storage must be durable, atomic, and exclusively managed by trusted
writers; the SDK does not install a database or a distributed lock.

The Node entry exports `createCommandArtifactOperation`. It requires an explicit
Foundation `CommandRunner`, absolute executable and working-directory paths, a
replacement environment, a bounded output limit, an observation adapter and its
version key. It uses an owned process scope bound to the operation fingerprint.
Exit zero with confirmed normal scope closure means `accepted`; remote readiness
still requires observation. Unsupported scopes fail without a fallback. Commands
receive `FORGE_ARTIFACT_REQUEST_ID`, `FORGE_ARTIFACT_FINGERPRINT`, and
`FORGE_ARTIFACT_CONTENT_MANIFEST_SHA256`, plus `FORGE_ARTIFACT_GIT_REVISION` only when supplied.
Callers cannot provide these association keys or the retired `FORGE_ARTIFACT_SOURCE_COMMIT`
in their replacement environment, regardless of casing. Parameters, environment values, command output and
raw exception causes are excluded from receipts. Keep secrets out of recorded
identifiers, targets, references and descriptors.

`ArtifactOperationError` exposes a stable `code`, `closure`, and an optional
`receipt`. Inspect `writeState`, `observation`, `journalState`, and `closure`
separately. `journalState: 'unknown'` means the receipt contains an attempted
record whose persistence is unconfirmed. Recovery preserves `attemptFailure`.
There are no automatic retries, redeployments, rollback, or business registration.

Operation records and object publication receipts use schema version 2. Legacy Git-only inputs and old operation records are rejected; unknown attempts are never automatically migrated or replayed.

The [operation and migration guide](../../docs/packages/artifacts/artifact-operations.md)
defines provider obligations, error semantics, examples and acceptance boundaries.
