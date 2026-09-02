# `@openge/forge-artifact-integrity`

Cross-runtime SHA-256 byte integrity and explicit Node.js file verification.

## Installation

```sh
pnpm add @openge/forge-artifact-integrity
```

## Usage

```ts
import { verifyBytesIntegrity } from '@openge/forge-artifact-integrity';
import {
  calculateFileIntegritySync,
  verifyBytesIntegritySync,
  verifyFileIntegrity,
} from '@openge/forge-artifact-integrity/node';

await verifyBytesIntegrity(bytes, { byteLength: 3, sha256: expectedDigest });
await verifyFileIntegrity('artifact.bin', {
  byteLength: expectedLength,
  sha256: expectedDigest,
});
const bytesIntegrity = verifyBytesIntegritySync(bytes, expectedIntegrity);
const fileIntegrity = calculateFileIntegritySync('artifact.bin');
```

The root entry uses Web Crypto and contains no Node.js imports. The `/node`
entry hashes asynchronous streams with cancellation support and also provides
synchronous byte and chunked-file APIs. File APIs reject symbolic links and
non-regular files.

## License

Licensed under the Apache License 2.0.
