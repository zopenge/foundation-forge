# `@openge/forge-peer-network-libp2p`

基于 libp2p 的显式 Peer Network Provider，分别提供 Node.js、浏览器和 relay 入口。

## 什么时候使用

适合已经采用 [`@openge/forge-peer-network`](peer-network.md) contract，并需要 libp2p transport、WebRTC/WebSocket、relay 等实际网络实现的应用。

如果只需要 WebSocket rendezvous 发现而不需要 libp2p 网络栈，应使用 `forge-peer-network-websocket`。

## 安装

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-libp2p
```

pnpm 10 workspace 使用 WebRTC transport 时，需要显式允许 `node-datachannel` native build，并把 `react-native-webrtc` 的 `react-native` peer 标记为 optional；具体配置以本包发布 README 为准。

## 可用入口

- `@openge/forge-peer-network-libp2p/node`：Node.js network 与 Provider。
- `@openge/forge-peer-network-libp2p/browser`：浏览器 network 与 Provider。
- `@openge/forge-peer-network-libp2p/relay`：relay 服务。

没有根入口，消费者必须明确选择运行时入口。

## 核心能力

- `createLibp2pNodePeerNetwork` / `createLibp2pNodePeerNetworkProvider`。
- `createLibp2pBrowserPeerNetwork` / `createLibp2pBrowserPeerNetworkProvider`。
- `createLibp2pRelay`：创建 relay 生命周期对象。
- 对外只暴露 Foundation Forge 网络 contract，不把 libp2p、multiaddr、private key 或 stream 类型传播给消费者。

## 快速使用

```ts
import { createLibp2pNodePeerNetworkProvider } from '@openge/forge-peer-network-libp2p/node';

const provider = createLibp2pNodePeerNetworkProvider();
const network = await provider.createNetwork();
console.log(network.endpoint);
await network.close();
```

## 行为与限制

运行时入口不会自动互相替换，也不会根据平台做隐式 Provider 选择。应用仍负责业务级发现策略、认证、房间和消息语义。

## 与其他 Foundation Forge 包的关系

本包实现 [`forge-peer-network`](peer-network.md) 的中立 contract；WebSocket rendezvous 是独立的 [`forge-peer-network-websocket`](peer-network-websocket.md)，可按应用拓扑单独或组合使用。

### pnpm 10 WebRTC 配置

使用 libp2p WebRTC transport 的 pnpm 10 workspace 需要显式配置：

```yaml
allowBuilds:
  node-datachannel: true

packageExtensions:
  "react-native-webrtc@*":
    peerDependenciesMeta:
      react-native:
        optional: true
```
