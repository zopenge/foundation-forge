# Foundation Forge

[![CI](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/zopenge/foundation-forge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Foundation Forge 提供与具体 Provider 无关、可跨平台复用的 TypeScript
基础能力，并以模块化 `@openge` 包发布。

[English](README.md)

## 包列表

| 包 | 用途 |
| --- | --- |
| `@openge/forge-peer-network` | 与 Provider 无关的对等网络契约、分帧、生命周期、错误与发现调度 |
| `@openge/forge-peer-network-libp2p` | 基于 libp2p 的显式 Node.js、浏览器和中继 Provider |
| `@openge/forge-peer-network-websocket` | WebSocket rendezvous client、hub 与 Node.js server adapter |

## 安装

安装中立契约，以及应用实际使用的一个 Provider：

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-libp2p
```

使用 libp2p WebRTC transport 的 pnpm 10 workspace 应增加以下定向原生构建与
条件 peer 配置：

```yaml
allowBuilds:
  node-datachannel: true

packageExtensions:
  "react-native-webrtc@*":
    peerDependenciesMeta:
      react-native:
        optional: true
```

若使用基于 WebSocket 的发现能力：

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-websocket
```

## 示例

```ts
import {
  createLibp2pNodePeerNetworkProvider,
} from '@openge/forge-peer-network-libp2p/node';

const provider = createLibp2pNodePeerNetworkProvider();
const network = await provider.createNetwork();

console.log(network.endpoint);

await network.close();
```

## 设计原则

- 中立契约不依赖任何 Provider 实现。
- Provider 必须由调用方显式选择，不使用运行时自动探测或隐式 fallback。
- 公开契约只使用 Foundation Forge 类型，不泄漏 libp2p 或 `ws` 实现类型。
- 运行逻辑返回结构化错误与诊断，不产生面向具体产品的展示文案。
- 每个包都可独立安装，并避免引入不相关的基础设施依赖。

## 范围

Foundation Forge 只承载可复用、领域中立的能力。

AI agent、游戏房间、匹配、业务流程、渲染引擎、应用数据库和产品专用文件系统
均不属于本仓库，应保留在拥有相应语境的仓库中。

只有当至少两个独立消费者共享同一份稳定、领域中立契约时，能力才允许提升到
Foundation Forge。

完整归属与准入规则见[架构边界](docs/architecture/boundaries.md)。

## 开发

环境要求：

- Node.js 22.14.0 或更高版本
- pnpm 10.33.2

```sh
pnpm install
pnpm check
```

## 版本与发布

各包遵循语义化版本，并通过 Changesets 统一版本。候选版本使用 npm `next`
dist-tag，稳定版使用 `latest`。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

漏洞请按 [SECURITY.md](SECURITY.md) 的私下报告流程提交。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
