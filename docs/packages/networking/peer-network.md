# `@openge/forge-peer-network`

领域中立的 Peer Network Core：定义统一 contract，并提供不绑定 transport 的分帧、可取消操作和拨号调度能力。

## 什么时候使用

适合需要在多个网络实现之间共享 endpoint、连接、消息、发现和生命周期语义的代码，也适合只复用协议工具而不引入 libp2p 或 `ws` 的场景。

如果已经确定只需要某个具体 transport，实现应来自 Provider package，而不是在这里寻找平台实现。

## 安装

```sh
pnpm add @openge/forge-peer-network
```

## 可用入口

- `@openge/forge-peer-network`：唯一公开入口，runtime-neutral，无第三方运行时依赖。

## 核心能力

- Peer endpoint、advertisement、network、provider、connection 与 message channel contract。
- 发现相关 contract、结构化 `PeerNetworkError` 与稳定错误语义。
- `createLengthPrefixedFrameCodec`：4 字节长度前缀的增量消息分帧，并限制单条消息大小。
- `runPeerNetworkOperation`：为网络操作提供一致的取消和错误处理边界。
- `createPeerDialScheduler`：对待连接 peer 做有界、可复用的拨号调度。

## 快速使用

```ts
import { createLengthPrefixedFrameCodec } from '@openge/forge-peer-network';

const codec = createLengthPrefixedFrameCodec({ maxMessageBytes: 64 * 1024 });
const message = new TextEncoder().encode('hello');
const frame = codec.encode(message);
const decoded = codec.decode(frame);
```

## 行为与限制

本包不实现 TCP、WebSocket、WebRTC、libp2p 或 relay，也不根据运行环境自动选择 Provider。业务重试、鉴权、房间、匹配、消息 schema 与持久化均属于消费者。

## 与其他 Foundation Forge 包的关系

具体实现见 [`forge-peer-network-libp2p`](peer-network-libp2p.md) 和 [`forge-peer-network-websocket`](peer-network-websocket.md)。Provider 的公开签名应使用本包 contract，而不是泄漏实现库类型。
