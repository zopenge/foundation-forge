# `@openge/forge-repository-context`

Deterministic repository indexing and evidence-backed investigation primitives.

The package root is runtime-neutral and exports corpus validation, search, relation traversal, response fitting, and investigation planning. Node-only repository discovery, generation storage, source reading, and the CLI are available from `@openge/forge-repository-context/node`. Language extraction is available through the TypeScript and C++ adapter subpaths.

Generated indexes are local caches. The CLI defaults to `.tmp/repository-context/`, verifies source digests before reading evidence, and refuses stale or incomplete generations.

Complete usage, contracts, examples, and ownership boundaries are maintained in the [Chinese usage documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/repository-tooling/repository-context.md).

For repository-wide capability discovery, see the [Foundation Forge documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/README.md).

Licensed under the Apache License 2.0.
