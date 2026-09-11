# 网络能力

这一组 package 提供领域中立的 Peer Network contract，以及显式选择的 libp2p 和 WebSocket rendezvous 实现。

## 怎么选

| 需求 | 使用 package |
| --- | --- |
| 统一的 Peer endpoint、连接、消息、发现、分帧和调度 contract | [`@openge/forge-peer-network`](peer-network.md) |
| 基于 libp2p 的 Node、浏览器或 relay Provider | [`@openge/forge-peer-network-libp2p`](peer-network-libp2p.md) |
| WebSocket rendezvous client、运行时中立 hub 或 Node server | [`@openge/forge-peer-network-websocket`](peer-network-websocket.md) |

## 组合关系

`forge-peer-network` 是中立 Core，不选择 transport。libp2p 与 WebSocket 两个 package 都向上实现或组合 Core contract，消费者显式安装并选择所需 Provider，不存在自动探测或隐式回退。
