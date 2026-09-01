# @openge/forge-peer-network-websocket

WebSocket rendezvous discovery for the Foundation Forge peer networking
contracts.

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-websocket
```

Use `@openge/forge-peer-network-websocket/client` with an injected standard
WebSocket factory in browser-capable environments. Use
`@openge/forge-peer-network-websocket/server` for the runtime-neutral rendezvous
hub or the Node.js `ws` server adapter.

The client entry does not import Node.js built-ins or the server implementation.

Licensed under the Apache License 2.0.
