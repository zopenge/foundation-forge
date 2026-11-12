# `@openge/forge-generated-artifacts`

Explicit generated-artifact plans, deterministic comparison, and safe Node.js publication.

The `/node` entry also provides explicitly selected Linux x64 and Windows x64 local
NTFS durable filesystems. `ensureDirectory` synchronizes new directory chains;
`publishBytes` supports exclusive publication or atomic replacement and acknowledges
only after content, published metadata, directory flushes and owned-handle closure.
These are OS/filesystem guarantees, conditional on storage honoring flush requests.
They do not provide a database transaction or protection against hostile ancestor
replacement. The existing `publishGeneratedArtifacts` API retains its original
atomic-publication contract.

Complete usage, public entrypoints, examples, publication semantics, and safety boundaries are maintained in the [中文使用文档](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/artifacts/generated-artifacts.md).

For repository-wide capability discovery, see the [Foundation Forge documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/README.md).

Licensed under the Apache License 2.0.
