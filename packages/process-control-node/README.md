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
const listeners = await processes.listTcpListeners({ ports: [3000] });
```

Callers explicitly choose `createWindowsProcessControl` with `powershell` or
`netstat`, or `createPosixProcessControl` with `lsof`. The provider never detects
a platform, switches backends, or retries through an implicit fallback.

Termination revalidates the PID start token before sending a graceful or force
signal. Windows uses `taskkill` for the process tree; Posix targets the process
group identified by the PID. Callers using Posix termination must launch the
owned process as its process-group leader. Command absence and command failures
are reported as structured Core errors.

## License

Licensed under the Apache License 2.0.
