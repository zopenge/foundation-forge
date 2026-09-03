# `@openge/forge-server-sent-events`

Runtime-neutral incremental Server-Sent Events encoding and decoding.

## Installation

```sh
pnpm add @openge/forge-server-sent-events
```

## Usage

```ts
import {
  createServerSentEventDecoder,
  encodeServerSentEvent,
} from '@openge/forge-server-sent-events';

const decoder = createServerSentEventDecoder({ maxEventBytes: 64 * 1024 });
const events = decoder.push(new TextEncoder().encode('event: ready\ndata: ok\n\n'));
const encoded = encodeServerSentEvent({ data: 'ok', event: 'ready' });
```

The decoder accepts arbitrary UTF-8 chunks, handles CR, LF, and CRLF event
boundaries, joins repeated `data` fields, and ignores comments. Invalid input
and resource-limit failures use structured `ServerSentEventError` instances.

HTTP connections, authentication, reconnection, heartbeat policy, and business
event schemas are deliberately outside this package.

## License

Licensed under the Apache License 2.0.
