# `@openge/forge-process-control-node`

Explicit Windows and Posix Node.js Providers for Foundation process control.

Use `createWindowsProcessIdentityReader()` or `createPosixProcessIdentityReader()`
for identity-only reads. Both implement the Core `ProcessIdentityReader` contract
and accept an optional `ProcessIdentityReaderOptions.runner` without requiring a
listener backend. The Windows identity reader uses .NET Process creation time
without loading PowerShell cmdlet modules and preserves the existing CIM JSON-date
start-token format. Posix retains `ps`. Permission failures are rejected without
retries or fallback sources; full Windows process queries retain their existing backend.

Complete usage, backend selection, examples, termination semantics, and provider boundaries are maintained in the [中文使用文档](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/process-execution/process-control-node.md).

For repository-wide capability discovery, see the [Foundation Forge documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/README.md).

Licensed under the Apache License 2.0.
