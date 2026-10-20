# `@openge/forge-process-control`

Provider-neutral process identity, listener selection, and termination contracts.

`ProcessIdentityReader` reads a single PID without requiring process metadata or
termination capabilities. `readIdentity({ pid, signal })` returns either
`{ status: 'FOUND', identity: { pid, startToken } }` or `{ status: 'ABSENT' }`.
Unconfirmed identities and query failures reject with `ProcessControlError`.

Complete usage, examples, contract semantics, and ownership boundaries are maintained in the [中文使用文档](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/process-execution/process-control.md).

For repository-wide capability discovery, see the [Foundation Forge documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/README.md).

Licensed under the Apache License 2.0.
