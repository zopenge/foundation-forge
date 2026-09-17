# @openge/forge-source-snapshot

Deterministic, provider-neutral source snapshots for Git repositories that need inspectable AI-readable exports without product-specific semantics.

## Capabilities

The runtime-neutral root entry provides:

- deterministic immutable snapshot manifests and file-change comparison;
- consumer-defined source classification and grouping;
- UTF-8/UTF-16 decoding and high-confidence secret detection;
- versioned source-text packing with normalized UTF-8 integrity, path-independent same-group exact content blocks, content-addressed objects, and separate logical/body/container byte metrics;
- published-artifact read indexes, exact byte locators, authenticated text reconstruction, and consumer-supplied read profiles;
- detached neutral relation validation for caller-collected `imports`/`exports`/`references`;
- detached evidence validation that checks schema, snapshot binding and caller-provided artifact hashes without executing evidence;
- pure pin-aware retention planning with configurable snapshot count and orphan grace period.

The explicit `@openge/forge-source-snapshot/node` entry provides:

- root/submodule Git inventory, including tracked and non-ignored untracked files;
- submodule initialization and strict parent-gitlink consistency gates, with an explicit checked-out-head opt-in that preserves parent-gitlink provenance;
- repository planning and frozen-input verification;
- bounded-working-set repository preparation with disk-backed text/object spooling for large repositories;
- filesystem publication, ownership markers and exclusive locks;
- post-publication object/text verification and source-independent read/unpack;
- explicit pin registry with revision/CAS semantics;
- managed-store physical usage, publication budgets, retention inspection and confirmed pruning;
- the reusable CLI runner used by the `forge-source-snapshot` binary.

## CLI

Create a consumer-owned `source-snapshot.config.mjs`, then run:

```sh
forge-source-snapshot plan --json
forge-source-snapshot export --json
forge-source-snapshot verify --json
forge-source-snapshot status --json
forge-source-snapshot prune --dry-run --json
forge-source-snapshot prune --json
forge-source-snapshot read --target-root <store> --owner-id <owner> --path <file> --json
forge-source-snapshot unpack --target-root <store> --owner-id <owner> --output <dir> --json
```

The configuration supplies project identity, source/target/state paths, classification policy, packing budgets, managed-store publication budgets, grouping, storage layout and retention settings. CLI `plan`/`export` use the Node prepared-spool pipeline so repository size does not require all decoded source and packed object bodies to remain resident in the V8 heap. The runtime-neutral in-memory packing API remains available for callers that already own bounded inputs. The package does not embed repository-specific names or storage-provider settings.

## Reading catalogs, coverage and provenance

The root entry exports `buildSnapshotReadCatalog`, `resolveSnapshotCatalog`, `verifySnapshotReadCatalog`, `readSnapshotCatalogText`, the coverage builder/resolver/verifier, and the provenance builder/verifier. The Node entry additionally exports `buildSnapshotCoverageFromPlan`, `buildSnapshotProvenanceFromPlan` and `prepareSnapshotWithProvenance`.

```ts
import { buildSnapshotReadCatalog, verifySnapshotReadCatalog } from '@openge/forge-source-snapshot';
const catalog = await buildSnapshotReadCatalog(manifest, { profile });
await verifySnapshotReadCatalog(manifest, catalog);
const pinnedDigest = catalog.root.sha256;
```

The caller supplies `manifest` and optional `profile`. Publish the returned artifacts to an explicitly managed reading root after pinning the source snapshot. Store the verified root digest through a trusted channel. The catalog root is at most 64 KiB and each shard is at most 256 KiB. Limits include UTF-8 framing; an unsplittable oversized record is rejected rather than truncated. Existing source objects and legacy indexes remain unchanged.

For a cold read, load `CATALOG.json` and call `resolveSnapshotCatalog(root, pinnedDigest, { kind: "path", path }, suppliedShards)`. A `needs-artifact` result identifies the next shard to obtain. Once found, fetch only the declared source objects and call `readSnapshotCatalogText(root, pinnedDigest, path, suppliedShards, objectBytes, limits)`. This API does not accept or load the full manifest. Its `maxTotalBytes` includes the verified catalog/shard bytes plus required source-object bytes. The result explicitly reports `sourceBinding: "caller-pinned-catalog"`.

An internally consistent hash does not establish trustworthy provenance: the initial full manifest/catalog comparison and trusted root pin are prerequisites. Object and normalized-text hashes are verified on the cold path; provider listing, credential, transport and retry behavior remain caller responsibilities. A missing shard is not an absent source file, and a path absent from the snapshot has unknown existence in the original repository.

Coverage is observation-only. Physical inclusion and preferred/reference reading priority are independent; reference files may retain complete text. Excluded or metadata-only entries cannot be promised on-demand text. Manifest-only historical snapshots keep unknown discovery and capture facts unknown. Provenance producer labels are caller declarations, not signatures, and `bodyVerification: "not-performed"` never becomes a body-verification receipt.

`prepareSnapshotWithProvenance` derives the catalog, coverage and source-state sidecar from one frozen capture. It does not promise a cross-repository atomic instant. Consumers must still enforce the publication freeze check, ownership/lock protocol, and source pins, then verify and switch their own reading entry. Release a source pin only after its last reading view is removed. The existing CLI commands remain compatible; these APIs provide the explicit reading-layer integration.

## Safety boundary

Publication writes immutable content objects and snapshot metadata before switching the current entry. Publication results distinguish physical `bytesWritten` and `objectsReused`; v2 alias add/remove does not change a shared content-block identity. Existing foreign targets, live locks, source/target overlap, submodule drift, secret findings, unknown review entries, source changes during planning, unsafe managed paths, integrity mismatches and managed-store budget violations fail closed. Submodule HEAD drift is strict by default; consumers that intentionally snapshot an aggregate development workspace may set `submoduleHeadPolicy: 'allow-checked-out'`, in which case the actual checked-out HEAD remains snapshot identity and a differing parent gitlink is retained as `parentGitlink` provenance in the manifest. Existing canonical snapshots can be reactivated without rewriting their immutable metadata.

Pruning revalidates retained snapshots before deletion. Active explicit pins extend the base retention set; pin state is revisioned and mutated under the same store lock. Physical usage counts only owner-managed objects, snapshot artifacts and state files, and counts shared objects once. Orphan age starts when an object is first observed without a retained reference; the default grace period is seven days. Deletion is confirmed by path disappearance, with a Windows fallback for filesystems whose primary delete call can report success without removing the path. A rollback to software that does not understand `.source-snapshot-pins.json` must not run prune; pin-aware software remains responsible for safe reclamation.

Evidence results use `schema-valid` and `source-bound` terminology only. They prove that supplied metadata and bytes are structurally consistent with a snapshot; they do not independently prove that a claimed test, command, runtime observation or cloud operation actually occurred. Command, URL and script strings remain inert metadata, and evidence validation never pins snapshots automatically.

The runtime-neutral root export has no Node/`ws` dependency path; Node-only APIs are isolated behind `@openge/forge-source-snapshot/node`, which is not exported under browser conditions. The package never discovers consumer plans/configuration or fetches upper-layer/cloud context. It does not run a background watcher or claim cloud synchronization. Consumers own scheduling, provider synchronization and any cloud readback verification.

## Local verification

```sh
pnpm --filter @openge/forge-source-snapshot build
pnpm --filter @openge/forge-source-snapshot typecheck
pnpm --filter @openge/forge-source-snapshot test
pnpm --filter @openge/forge-source-snapshot test:coverage
pnpm pack:check
```

The repository package verifier also installs the real tarball into an isolated consumer and exercises the public runtime, Node entry, binary and type declarations.

Repository guide: [Chinese usage and boundaries](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/repository-tooling/source-snapshot.md).
