# `@openge/forge-peer-network-websocket`

为 Foundation Forge Peer Network 提供 WebSocket rendezvous 发现，拆分为 client、runtime-neutral hub 和 Node.js server adapter。

## 什么时候使用

适合需要一个轻量 rendezvous 服务来发布和接收 `PeerAdvertisement` 的场景；浏览器、非 Node host 和 Node server 可以选择各自入口。

它不是完整的 Peer 数据传输层，主要解决发现与 rendezvous。

## 安装

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-websocket
```

## 可用入口

- `@openge/forge-peer-network-websocket/client`：注入标准 WebSocket factory 的发现客户端。
- `@openge/forge-peer-network-websocket/hub`：不绑定 Node 的 rendezvous hub。
- `@openge/forge-peer-network-websocket/server`：基于 `ws` 的 Node.js server adapter，并继续重导出 Hub API。

## 核心能力

- `createWebSocketPeerDiscovery`：注册本地 advertisement、接收 peer 列表、心跳和断线重连。
- `createWebSocketRendezvousHub`：管理连接、注册授权、advertisement 集合和结构化诊断。
- `createWebSocketRendezvousServer`：把 hub 接到 Node.js `ws` server。
- 协议解析对异常输入做显式过滤，并限制 rendezvous payload 大小。

## 快速使用

```ts
import { createWebSocketPeerDiscovery } from '@openge/forge-peer-network-websocket/client';

const discovery = createWebSocketPeerDiscovery({
  advertisement,
  token,
  url: 'wss://example.test/rendezvous',
  webSocketFactory: (url) => new WebSocket(url),
});

const unsubscribe = discovery.onAdvertisements((peers) => console.log(peers));
unsubscribe();
discovery.close();
```

## 行为与限制

`client` 和 `hub` 不导入 Node.js built-ins、`ws` 或 server 实现。鉴权规则由 hub 调用方提供；TLS、HTTP 路由、持久化、业务房间与 peer 连接本身不属于本包。

## 与其他 Foundation Forge 包的关系

advertisement 与 discovery contract 来自 [`forge-peer-network`](peer-network.md)。需要实际 libp2p peer transport 时使用 [`forge-peer-network-libp2p`](peer-network-libp2p.md)。
