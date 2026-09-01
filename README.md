# Foundation Forge

[![CI](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Provider-neutral TypeScript foundation libraries for reusable cross-platform
capabilities, published as modular `@openge` packages.

[简体中文](README.zh-CN.md)

## Packages

| Package | Purpose |
| --- | --- |
| `@openge/forge-peer-network` | Provider-neutral peer networking contracts, framing, lifecycle, errors, and discovery scheduling |
| `@openge/forge-peer-network-libp2p` | Explicit Node.js, browser, and relay providers based on libp2p |
| `@openge/forge-peer-network-websocket` | WebSocket rendezvous client, hub, and Node.js server adapter |

## Installation

Install the neutral contracts together with only the provider your application
uses:

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-libp2p
```

pnpm 10 workspaces using the libp2p WebRTC transport should add the following
targeted native-build and conditional-peer configuration:

```yaml
allowBuilds:
  node-datachannel: true

packageExtensions:
  "react-native-webrtc@*":
    peerDependenciesMeta:
      react-native:
        optional: true
```

For WebSocket-based discovery:

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-websocket
```

## Example

```ts
import {
  createLibp2pNodePeerNetworkProvider,
} from '@openge/forge-peer-network-libp2p/node';

const provider = createLibp2pNodePeerNetworkProvider();
const network = await provider.createNetwork();

console.log(network.endpoint);

await network.close();
```

## Design principles

- Provider-neutral contracts stay independent from provider implementations.
- Providers are selected explicitly; runtime auto-detection and implicit fallbacks are not used.
- Public contracts use Foundation Forge types and do not expose libp2p or `ws` implementation types.
- Runtime behavior returns structured errors and diagnostics rather than user-facing product copy.
- Packages remain independently installable and avoid unrelated infrastructure dependencies.

## Scope

Foundation Forge owns reusable, domain-neutral capabilities.

It does not define AI agents, game rooms, matchmaking, business workflows,
rendering engines, application databases, or product-specific file systems.
Those concerns remain in their owning repositories.

A capability is promoted here only after at least two independent consumers
share the same stable, domain-neutral contract.

See [Architecture boundaries](docs/architecture/boundaries.md) for the complete
ownership and admission rules.

## Development

Requirements:

- Node.js 22.14.0 or newer
- pnpm 10.33.2

```sh
pnpm install
pnpm check
```

## Versioning and releases

The packages follow Semantic Versioning and are versioned together with
Changesets. Release candidates use the `next` npm dist-tag. Stable releases use
`latest`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.

## License

Licensed under the [Apache License 2.0](LICENSE).
