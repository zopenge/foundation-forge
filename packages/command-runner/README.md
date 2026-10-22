# `@openge/forge-command-runner`

Provider-neutral asynchronous command execution with a bounded Node.js process lifecycle.

Inject an `ownedScopeProvider` to opt into OS-owned command execution. A spec
uses `ownedScope: { start: 'automatic' | 'manual', binding }`. Manual mode requires
`start()` and a finite timeout: wait for `scope-ready`, persist the identity and
binding, then call `running.authorizeStart()`. `run()` rejects manual mode.
Owned scopes require force termination and return OS closure in `result.ownedScope`;
unknown closure is a termination failure. Ordinary commands keep their existing
behavior and do not load a native Provider.

Complete usage, public entrypoints, output policies, lifecycle semantics, examples, and ownership boundaries are maintained in the [中文使用文档](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/process-execution/command-runner.md).

For repository-wide capability discovery, see the [Foundation Forge documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/README.md).

Licensed under the Apache License 2.0.
