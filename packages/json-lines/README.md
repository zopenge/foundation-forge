# `@openge/forge-json-lines`

Runtime-neutral incremental JSON Lines encoding and decoding.

## Installation

```sh
pnpm add @openge/forge-json-lines
```

## Usage

```ts
import { createJsonLinesDecoder, encodeJsonLine } from '@openge/forge-json-lines';

const decoder = createJsonLinesDecoder({ maxLineBytes: 64 * 1024 });
const records = decoder.push(new TextEncoder().encode('{"ready":true}\n'));
const encoded = encodeJsonLine({ ready: true });
```

Chunks may split UTF-8 code points or line delimiters. Call `finish()` when the
input ends to parse a final unterminated record. Invalid UTF-8, invalid JSON,
oversized lines, and use after `finish()` produce structured `JsonLinesError`
instances.

The package owns framing and JSON conversion only. Streams, transports, log
semantics, schemas, retries, and persistence remain with the consumer.

## License

Licensed under the Apache License 2.0.
