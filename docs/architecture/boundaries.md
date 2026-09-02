# 仓库与能力边界

本文面向公共基础库维护者和依赖架构负责人，是能力归属与准入判断的权威文档。公开包的安装和使用从根 [README](../../README.md) 进入。

## 分层职责

| 层级 | 所有权 | 依赖方向 |
| --- | --- | --- |
| 公共基础层 | 领域中立、可独立版本化、跨产品复用的 TypeScript contract 与 Provider | 只依赖领域中立的第三方基础库或本仓库中更底层的公开包 |
| 高性能运行时层 | 渲染、Native/WASM、高性能计算和运行时适配 | 可依赖公共基础层，不得要求公共基础层理解运行时实现语义 |
| 平台与服务层 | AI、数据、网络服务和平台级编排 | 可依赖公共基础层及明确需要的运行时能力 |
| 产品与业务层 | 房间、匹配、业务流程、UI 和客户语义 | 可组合下层公开能力，领域规则只能保留在本层 |

依赖必须从拥有领域语境的上层指向中立基础层。公共基础层不得引用具体消费者、反向依赖消费者代码，或复制消费者的配置、术语和业务语义。

## 准入规则

能力进入公共基础层前必须同时满足：

1. 至少两个独立消费者已经共享同一问题与稳定 contract。
2. contract 不包含 AI、游戏、房间、业务流程、具体 UI 或客户语义。
3. 能力可以单独安装、测试和版本化，不要求消费者引入无关基础设施。
4. 第三方实现可以封装在独立 Provider 包中，且中立 Core 不暴露其类型。
5. 代码及依赖许可证允许以 Apache-2.0 仓库公开分发。

仅因“未来可能复用”不构成准入依据。尚未稳定或只有一个消费者的实现继续由原仓库持有。

## 常见能力归属

- 数据库：连接、迁移和 ORM 装配保留在拥有数据模型的应用；只有稳定的中立 contract 且存在多个消费者时才评估提取。
- 文件 I/O：产品目录、权限和文件语义保留在应用；纯数据转换可在满足准入规则后提取。
- 渲染与 Native/WASM：属于高性能运行时层，不进入公共基础层。
- 网络：中立连接、消息、发现 contract 可进入公共基础层；具体 Provider 独立封装。
- 房间通信、Lobby 和匹配：属于产品与业务层；可组合中立网络能力，但不得下沉房间语义。
- AI service、agent 与模型适配：属于平台与服务层，不进入公共基础层。

## Peer Network 首期边界

`@openge/forge-peer-network` 只提供中立 contract、生命周期、分帧、操作控制与拨号调度，零运行时第三方依赖。

`@openge/forge-peer-network-libp2p` 明确区分 Node.js、浏览器和 relay 入口，完整封装 libp2p 类型与依赖。

`@openge/forge-peer-network-websocket` 将浏览器 client、跨运行时 hub 与 Node server 分开；client 使用调用方注入的标准 WebSocket factory，hub 只依赖 Foundation Core 与 Web Platform API，只有 server 依赖 `ws` 和 Node 内置模块。server 为兼容既有公开契约继续重导出 hub。

## Text Integrity 边界

`@openge/forge-text-integrity` 的根入口只提供领域中立的纯文本完整性检测，不依赖 Node.js 内置模块或文件系统。`/node` 入口负责文本路径扫描，并组合 `@openge/forge-repository-files` 完成 Git ignore 与 changed-file 收集；CLI 只将结构化问题格式化为命令行诊断。

公共 contract 不持有具体消费者的仓库目录、默认扫描根和产品特有忽略项。消费者可通过明确选项提供这些配置；检测规则、文本文件类型并集和稳定排序则由公共包维护为唯一实现。

## Repository Files 边界

`@openge/forge-repository-files` 只执行只读 Git 文件发现、changed-file 收集、ignore 过滤、路径规范化和稳定排序。它不提供 commit、branch、push 等写操作，不持有任何消费者的索引或上下文语义，并且 Git 不可用时显式失败而不递归扫描文件系统。

## Deterministic JSON 边界

`@openge/forge-deterministic-json` 只接受严格 JSON 数据，递归复制并按 UTF-16 code-unit 顺序排列对象键。它拒绝循环引用、稀疏数组、访问器、自定义原型和非 JSON 值，不负责摘要、持久化、schema 校验或 RFC canonical JSON。

## Artifact Integrity 边界

`@openge/forge-artifact-integrity` 的根入口只使用 Web Crypto 计算和验证字节长度与 SHA-256；`/node` 入口增加可取消的异步普通文件流式校验，以及同步字节和分块文件校验。下载、凭据、缓存、制品来源和业务身份规则仍由消费者持有。

## Path Safety 边界

`@openge/forge-path-safety` 的根入口只验证和规范化使用 `/` 的领域中立相对路径，不依赖 Node.js 内置模块。`/node` 入口区分词法包含与基于 `realpath` 的既有路径包含；前者不声称防止符号链接逃逸。产品目录白名单、权限策略和文件生命周期仍由消费者持有。

## Archive Safety 边界

`@openge/forge-archive-safety` 组合 Path Safety 的便携路径规则，并保留归档目录条目的尾部 `/` contract 与独立错误类型。它只验证归档条目路径、条目类型、展开大小和条目数量。归档格式解析、下载、临时目录、系统命令与实际解压属于 Provider 或消费者，不进入该公共包。
