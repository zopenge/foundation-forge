# `@openge/forge-repository-files`

Deterministic read-only Git repository file discovery for Node.js tooling.

Cancellation waits for the Git child process and its streams to close before the operation rejects, so callers can safely clean up their operation-owned resources afterward.

Complete usage, examples, path behavior, and repository boundaries are maintained in the [中文使用文档](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/repository-tooling/repository-files.md).

For repository-wide capability discovery, see the [Foundation Forge documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/README.md).

Licensed under the Apache License 2.0.
