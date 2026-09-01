# @openge/forge-peer-network-websocket

WebSocket rendezvous discovery for the Foundation Forge peer networking
contracts.

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-websocket
```

Use `@openge/forge-peer-network-websocket/client` with an injected standard
WebSocket factory in browser-capable environments. Use the runtime-neutral
`@openge/forge-peer-network-websocket/hub` entry when the host runtime supplies
the connection adapter. Use `@openge/forge-peer-network-websocket/server` only
for the Node.js `ws` server adapter; it continues to re-export the Hub API.

The client and hub entries do not import Node.js built-ins, `ws`, or the server
implementation.

Licensed under the Apache License 2.0.
