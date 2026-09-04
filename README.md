# Foundation Forge

[![CI](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Provider-neutral TypeScript foundation libraries for reusable cross-platform
capabilities, published as modular `@openge` packages.

## Packages

| Package | Purpose |
| --- | --- |
| `@openge/forge-peer-network` | Provider-neutral peer networking contracts, framing, lifecycle, errors, and discovery scheduling |
| `@openge/forge-peer-network-libp2p` | Explicit Node.js, browser, and relay providers based on libp2p |
| `@openge/forge-peer-network-websocket` | WebSocket rendezvous client, hub, and Node.js server adapter |
| `@openge/forge-text-integrity` | Runtime-neutral text corruption inspection plus explicit Node.js repository scanning and CLI support |
| `@openge/forge-repository-files` | Deterministic read-only Git repository file discovery and ignore filtering |
| `@openge/forge-repository-context` | Pure registry validation, bounded context selection, impact closure, budget diagnostics, and deterministic output comparison |
| `@openge/forge-generated-artifacts` | Explicit artifact plans, deterministic comparison, and safe Node.js atomic publication |
| `@openge/forge-deterministic-json` | Strict deterministic JSON validation, sorting, and serialization |
| `@openge/forge-path-safety` | Cross-runtime portable relative-path validation plus explicit Node.js root containment |
| `@openge/forge-artifact-integrity` | Cross-runtime byte integrity plus explicit asynchronous and synchronous Node.js file verification |
| `@openge/forge-archive-safety` | Runtime-neutral archive entry path and resource-limit validation |
| `@openge/forge-archive-zip` | Runtime-neutral deterministic ZIP32 encoding, inspection, and bounded decoding |
| `@openge/forge-config-bundle` | Deterministic manifest-backed configuration bundles with staged Node.js import, backups, and rollback reporting |
| `@openge/forge-json-lines` | Incremental, bounded JSON Lines encoding and decoding across arbitrary byte chunks |
| `@openge/forge-server-sent-events` | Incremental Server-Sent Events framing and parsing without transport ownership |
| `@openge/forge-workspace-graph` | Pure deterministic workspace dependency graph construction and traversal |
| `@openge/forge-workspace-checks` | Pure reusable workspace graph checks and package-cycle diagnostics |
| `@openge/forge-workspace-pnpm` | Explicit Node.js provider for reading pnpm workspaces into neutral graphs |
| `@openge/forge-workspace-checks-pnpm` | pnpm workspace checks CLI assembly and integration facade |
| `@openge/forge-process-control` | Provider-neutral process identity, listener selection, and termination contracts |
| `@openge/forge-process-control-node` | Explicit Windows and Posix process discovery and termination providers |
| `@openge/forge-command-runner` | Bounded asynchronous command execution with explicit process identity and termination providers |

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

Import the runtime-neutral rendezvous Hub from
`@openge/forge-peer-network-websocket/hub`. The `/server` entry is reserved for
the Node.js `ws` adapter and continues to re-export the Hub API.

For text integrity inspection and repository scanning:

```sh
pnpm add -D @openge/forge-text-integrity
```

The root entry is runtime-neutral. Node.js filesystem, Git, and CLI support is
available from `@openge/forge-text-integrity/node` and the
`forge-text-integrity` executable.

For repository-aware development tooling:

```sh
pnpm add -D @openge/forge-repository-files
```

For pure deterministic data and artifact validation:

```sh
pnpm add @openge/forge-deterministic-json \
  @openge/forge-path-safety \
  @openge/forge-artifact-integrity \
  @openge/forge-archive-safety
```

For bounded streaming protocols:

```sh
pnpm add @openge/forge-json-lines @openge/forge-server-sent-events
```

For ZIP32 archives with pre-decompression safety checks:

```sh
pnpm add @openge/forge-archive-zip
```

For workspace tooling or process control, install the neutral Core together with
the explicit Node.js integration or Provider you use:

```sh
pnpm add -D @openge/forge-workspace-graph @openge/forge-workspace-pnpm
pnpm add -D @openge/forge-workspace-checks @openge/forge-workspace-checks-pnpm
pnpm add -D @openge/forge-process-control @openge/forge-process-control-node
```

Run the package-cycle gate for a pnpm workspace:

```sh
forge-workspace-checks --cwd . --check package-cycles
```

## Generated artifacts, commands, and configuration bundles

Three independently versioned packages cover shared tooling lifecycles:

- [Generated Artifacts](packages/generated-artifacts/README.md) compares explicit
  plans and publishes changed files atomically. It never owns an entire output directory.
- [Command Runner](packages/command-runner/README.md) starts one asynchronous
  command with bounded capture, timeout, heartbeat, and cancellation. Callers inject
  their Process Control provider and explicit termination budgets.
- [Config Bundle](packages/config-bundle/README.md) defines a deterministic ZIP
  manifest format and supports staged imports with explicit conflict policies.

Their root entries are runtime-neutral; filesystem and child-process operations
are exported only from `/node`. Filesystem callers choose path case sensitivity
explicitly. Product file selection, secret checks, service ordering, and log
formatting remain in the consuming application.

The initial `0.1.0-rc.0` manifests are bootstrap candidates. Follow the
[release procedure](docs/maintenance/releases.md) before adopting a published
version in a consumer. Workspace packaging checks do not publish these packages.

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

The packages follow Semantic Versioning and use Changesets. The three Peer
Network packages share a fixed version while unrelated packages can evolve
independently. Release candidates use the `next` npm dist-tag. Stable releases
use `latest`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.

## License

Licensed under the [Apache License 2.0](LICENSE).
