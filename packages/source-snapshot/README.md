# @openge/forge-source-snapshot

Deterministic, provider-neutral source snapshots for Git repositories that need inspectable AI-readable exports without product-specific semantics.

## Capabilities

The runtime-neutral root entry provides:

- deterministic immutable snapshot manifests and file-change comparison;
- consumer-defined source classification and grouping;
- UTF-8/UTF-16 decoding and high-confidence secret detection;
- complete Markdown packing with content-addressed objects;
- reconstruction and segment-coverage validation;
- pure retention planning with configurable snapshot count and orphan grace period.

The explicit `@openge/forge-source-snapshot/node` entry provides:

- root/submodule Git inventory, including tracked and non-ignored untracked files;
- submodule initialization and parent-gitlink consistency gates;
- repository planning and frozen-input verification;
- filesystem publication, ownership markers and exclusive locks;
- post-publication integrity verification;
- retention inspection, confirmed pruning and garbage-collection state;
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
```

The configuration supplies project identity, source/target/state paths, classification policy, packing budgets, grouping, storage layout and retention settings. The package does not embed repository-specific names or storage-provider settings.

## Safety boundary

Publication writes immutable content objects and snapshot metadata before switching the current entry. Existing foreign targets, live locks, source/target overlap, submodule drift, secret findings, unknown review entries, source changes during planning, unsafe managed paths and integrity mismatches fail closed.

Pruning revalidates retained snapshots before deletion. Orphan age starts when an object is first observed without a retained reference; the default grace period is seven days. Deletion is confirmed by path disappearance, with a Windows fallback for filesystems whose primary delete call can report success without removing the path.

The package does not run a background watcher or claim cloud synchronization. Consumers own scheduling, provider synchronization and any cloud readback verification.

## Local verification

```sh
pnpm --filter @openge/forge-source-snapshot build
pnpm --filter @openge/forge-source-snapshot typecheck
pnpm --filter @openge/forge-source-snapshot test
pnpm --filter @openge/forge-source-snapshot test:coverage
```

The repository package verifier also installs the real tarball into an isolated consumer and exercises the public runtime, Node entry, binary and type declarations.

Repository guide: [Chinese usage and boundaries](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/repository-tooling/source-snapshot.md).
