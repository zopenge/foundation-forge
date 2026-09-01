# `@openge/forge-archive-safety`

Runtime-neutral archive entry path and resource-limit validation.

## Installation

```sh
pnpm add @openge/forge-archive-safety
```

## Usage

```ts
import { inspectArchiveEntries } from '@openge/forge-archive-safety';

const summary = inspectArchiveEntries([
  { path: 'payload/', kind: 'directory' },
  { path: 'payload/data.bin', kind: 'file', uncompressedBytes: 1024 },
]);
```

The package rejects absolute paths, traversal segments, backslashes, links,
unsupported entry kinds, invalid sizes, excessive entry counts, and excessive
expanded byte totals. It does not download, inspect archive formats, invoke
system tools, or extract files; consumers and Provider adapters retain those
responsibilities.

## License

Licensed under the Apache License 2.0.
