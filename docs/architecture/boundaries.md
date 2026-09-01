# 仓库与能力边界

本文面向 Foundation Forge 维护者和跨仓库架构负责人，是能力归属与准入判断的权威文档。公开包的安装和使用从根 [README](../../README.md) 进入。

## 仓库职责

| 仓库 | 所有权 | 允许依赖 |
| --- | --- | --- |
| Foundation Forge | 领域中立、可独立版本化、跨产品复用的 TypeScript contract 与 Provider | 第三方基础库；不得依赖其他 Forge 产品仓库 |
| AI Forge | AI 前后端平台、agent、service、模型与 AI 业务编排 | Foundation Forge；需要高性能运行时能力时依赖 Runtime Forge |
| Runtime Forge | 渲染、Native/WASM、高性能计算和运行时适配 | Foundation Forge 中确有需要的中立 contract |
| Game Forge | 游戏平台、房间、Lobby、匹配和游戏产品语义 | Foundation Forge、AI Forge、Runtime Forge 中实际需要的公开能力 |
| Link Light | 业务应用和业务工作流 | Foundation Forge、AI Forge 中实际需要的公开能力 |

依赖方向必须从拥有产品语境的上层仓库指向中立基础层。Foundation Forge 不得反向依赖或复制上层语义。

## 准入规则

能力进入 Foundation Forge 前必须同时满足：

1. 至少两个独立消费者已经共享同一问题与稳定 contract。
2. contract 不包含 AI、游戏、房间、业务流程、具体 UI 或客户语义。
3. 能力可以单独安装、测试和版本化，不要求消费者引入无关基础设施。
4. 第三方实现可以封装在独立 Provider 包中，且中立 Core 不暴露其类型。
5. 代码及依赖许可证允许以 Apache-2.0 仓库公开分发。

仅因“未来可能复用”不构成准入依据。尚未稳定或只有一个消费者的实现继续由原仓库持有。

## 常见能力归属

- 数据库：连接、迁移和 ORM 装配保留在拥有数据模型的应用；只有稳定的中立 contract 且存在多个消费者时才评估提取。
- 文件 I/O：产品目录、权限和文件语义保留在应用；纯数据转换可在满足准入规则后提取。
- 渲染与 Native/WASM：属于 Runtime Forge，不进入 Foundation Forge。
- 网络：中立连接、消息、发现 contract 可进入 Foundation Forge；具体 Provider 独立封装。
- 房间通信、Lobby 和匹配：属于 Game Forge；可组合中立网络能力，但不得下沉房间语义。
- AI service、agent 与模型适配：属于 AI Forge，不进入 Foundation Forge。

## Peer Network 首期边界

`@openge/forge-peer-network` 只提供中立 contract、生命周期、分帧、操作控制与拨号调度，零运行时第三方依赖。

`@openge/forge-peer-network-libp2p` 明确区分 Node.js、浏览器和 relay 入口，完整封装 libp2p 类型与依赖。

`@openge/forge-peer-network-websocket` 将浏览器 client、跨运行时 hub 与 Node server 分开；client 使用调用方注入的标准 WebSocket factory，hub 只依赖 Foundation Core 与 Web Platform API，只有 server 依赖 `ws` 和 Node 内置模块。server 为兼容既有公开契约继续重导出 hub。
