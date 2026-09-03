# `@openge/forge-process-control`

Provider-neutral contracts and deterministic selection for explicit process control.

## Installation

```sh
pnpm add @openge/forge-process-control
```

## Usage

```ts
import { selectTcpListeners } from '@openge/forge-process-control';

const selected = selectTcpListeners(discoveredListeners, { ports: [3000, 5173] });
```

The Core package defines process identities using both PID and a stable start
token, process descriptors, TCP listener records, explicit single-process and
process-tree termination policies, Provider contracts, stable selection, and
structured errors. It performs no operating-system I/O.

Process launch, service ownership, platform selection, recovery policy, and
user-facing diagnostics remain with the consumer.

## License

Licensed under the Apache License 2.0.
