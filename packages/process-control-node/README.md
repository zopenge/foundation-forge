# `@openge/forge-process-control-node`

Explicit Windows and Posix Node.js Providers for Foundation process control.

Use `createWindowsProcessIdentityReader()` or `createPosixProcessIdentityReader()`
for identity-only reads. Both implement the Core `ProcessIdentityReader` contract
and accept an optional `ProcessIdentityReaderOptions.runner` without requiring a
listener backend. The Windows identity reader uses .NET Process creation time
without loading PowerShell cmdlet modules and preserves the existing CIM JSON-date
start-token format. Posix retains `ps`. Permission failures are rejected without
retries or fallback sources; full Windows process queries retain their existing backend.

On Windows x64, explicitly choose `createWindowsNativeProcessIdentityReader()` to
read a known PID through the installed Koffi prebuild and Win32 process handles.
It preserves the millisecond start-token format, checks process liveness before
and after reading creation time, and closes each query handle. It never enumerates
processes or falls back to a command reader. Cancellation and access, loading, ABI,
or cleanup failures remain errors; an unreadable identity is not absence. The
existing command readers remain available without changing their behavior.

Explicit `createWindowsOwnedProcessScopeProvider()` and
`createLinuxOwnedProcessScopeProvider()` implement owned command scopes on
Windows x64 (Job Objects) and Linux/glibc x64 (subreaper, wait/reap and pidfds).
Other hosts, missing native capabilities or unsupported Job assignment fail
before the job starts. Owned scopes currently require force termination.
Windows retains verified member handles while allowing natural descendant exit
for at most the smaller of one second and half the configured termination budget.
Helper shutdown and final Job emptiness verification share the remaining deadline.
Cancellation, timeout, unknown membership, or forced cleanup can never become a
normal completion, even if the Job is empty afterward.
Koffi is pinned to 3.3.3 and loaded lazily from installed prebuilds; runtime code
never downloads or compiles a fallback. With pnpm, set `allowBuilds.koffi: false`
when installing to prevent Koffi's optional install-time compilation fallback.

These scopes manage trusted foreground commands, not a security sandbox.
Commands must not delegate execution to WMI, system services or another external
process owner. Normal closure differs from successful forced cleanup: cleanup
can prove emptiness while completion remains unknown.

Complete usage, backend selection, examples, termination semantics, and provider boundaries are maintained in the [中文使用文档](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/process-execution/process-control-node.md).

For repository-wide capability discovery, see the [Foundation Forge documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/README.md).

Licensed under the Apache License 2.0.
