# Foundation Forge

[![CI](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Provider-neutral TypeScript foundation libraries for reusable cross-platform capabilities, published as modular `@openge` packages.

## Documentation

- [中文使用文档](docs/README.md)：按问题查找能力、选择 package，并进入每个 package 的完整中文说明。
- [Architecture boundaries](docs/architecture/boundaries.md)：仓库级能力准入、分层和依赖方向。
- [Release procedure](docs/maintenance/releases.md)：维护者发布与验证流程。

## Capability areas

| Area | What it provides | Documentation |
| --- | --- | --- |
| Networking | Peer Network contracts plus explicit libp2p and WebSocket rendezvous providers | [网络能力](docs/packages/networking/README.md) |
| Data formats | Deterministic JSON and bounded incremental text protocols | [数据格式与流式协议](docs/packages/data-formats/README.md) |
| Artifacts | Path safety, integrity, archives, generated files, and configuration bundles | [制品与文件安全](docs/packages/artifacts/README.md) |
| Repository tooling | Git file discovery, repository context planning, text integrity, and deterministic source snapshots | [仓库工具](docs/packages/repository-tooling/README.md) |
| Workspace tooling | Neutral dependency graphs, pnpm discovery, checks, and CLI integration | [Workspace 工具](docs/packages/workspace-tooling/README.md) |
| Process execution | Process-control contracts/providers and bounded asynchronous command execution | [进程与命令执行](docs/packages/process-execution/README.md) |

Install only the packages required by your application. Exact package names, public entrypoints, examples, and limitations are documented once in the linked package pages rather than duplicated here.

## Design principles

- Provider-neutral contracts stay independent from provider implementations.
- Providers are selected explicitly; runtime auto-detection and implicit fallbacks are not used.
- Public contracts use Foundation Forge types and do not expose provider implementation types.
- Runtime behavior returns structured errors and diagnostics rather than product-specific copy.
- Packages remain independently installable and avoid unrelated infrastructure dependencies.

## Scope

Foundation Forge owns reusable, domain-neutral capabilities.

It does not define AI agents, game rooms, matchmaking, business workflows, rendering engines, application databases, or product-specific file systems. Those concerns remain in their owning repositories.

A capability is promoted here only after at least two independent consumers share the same stable, domain-neutral contract. See [Architecture boundaries](docs/architecture/boundaries.md) for the complete admission rules.

## Development

Requirements:

- Node.js 22.14.0 or newer
- pnpm 10.33.2

```sh
pnpm install
pnpm check
```

## Versioning and releases

Packages follow Semantic Versioning and use Changesets. Related package families may share fixed versions while unrelated packages evolve independently. Release candidates use the `next` npm dist-tag; stable releases use `latest`.

Pushing reviewed changes to `main` automatically triggers the Release workflow. With pending Changesets, it creates or updates the `Version Packages` pull request; merging that PR triggers the stable publish path automatically. The only manual publication exception is the one-time bootstrap required for a brand-new npm package before Trusted Publishing can be configured.

Published versions must complete the Trusted Publishing and clean-consumer verification process documented in the [release procedure](docs/maintenance/releases.md). Workspace packaging checks do not publish packages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.

## License

Licensed under the [Apache License 2.0](LICENSE).
