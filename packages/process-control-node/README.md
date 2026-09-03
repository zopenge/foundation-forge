# `@openge/forge-process-control-node`

Explicit Windows and Posix Node.js Providers for `@openge/forge-process-control`.

## Installation

```sh
pnpm add @openge/forge-process-control @openge/forge-process-control-node
```

## Usage

```ts
import { createWindowsProcessControl } from '@openge/forge-process-control-node';

const processes = createWindowsProcessControl({ listenerBackend: 'powershell' });
const running = await processes.listProcesses();
const listeners = await processes.listTcpListeners({ ports: [3000] });
```

Callers explicitly choose `createWindowsProcessControl` with `powershell` or
`netstat`, or `createPosixProcessControl` with `lsof`. The provider never detects
a platform, switches backends, or retries through an implicit fallback.

Process discovery returns stable identities together with the available name,
command path, command line, and parent PID. Termination revalidates the PID start
token before sending a graceful or force signal. `terminateProcess` targets one
process; `terminateProcessTree` uses `taskkill /T` on Windows and the process
group identified by the PID on Posix. Callers using Posix tree termination must
launch the owned process as its process-group leader. Command absence and
command failures are reported as structured Core errors.

## License

Licensed under the Apache License 2.0.
