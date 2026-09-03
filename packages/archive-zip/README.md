# `@openge/forge-archive-zip`

Runtime-neutral ZIP32 archive Provider with bounded safety validation.

## Installation

```sh
pnpm add @openge/forge-archive-zip
```

## Usage

```ts
import { decodeZipArchive, encodeZipArchive } from '@openge/forge-archive-zip';

const archive = encodeZipArchive([
  { bytes: new TextEncoder().encode('hello'), kind: 'file', path: 'hello.txt' },
], { compression: 'deflate' });

const decoded = decodeZipArchive(archive, {
  limits: { maxArchiveBytes: 8 * 1024 * 1024, maxExpandedBytes: 32 * 1024 * 1024 },
});
```

The provider creates deterministic ZIP32 archives and validates the central
directory before decompression. It rejects encryption, ZIP64, unsupported
methods, unsafe paths and entry kinds, duplicate names, inconsistent headers,
CRC mismatches, and configured resource-limit violations.

Only in-memory bytes are handled. Downloading, filesystem extraction, cache
policy, credentials, and product artifact semantics belong to the consumer.

## License

Licensed under the Apache License 2.0.
