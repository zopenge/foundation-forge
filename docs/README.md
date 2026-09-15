# Foundation Forge 中文文档

这里是 Foundation Forge 的中文使用文档入口。仓库提供领域中立、可独立安装的 TypeScript 基础能力；具体 package 的完整用法以 `docs/packages/` 下对应页面为准。

## 按问题查找能力

| 你要解决的问题 | 能力域 |
| --- | --- |
| Peer 连接、发现、libp2p 或 WebSocket rendezvous | [网络](packages/networking/README.md) |
| 稳定 JSON、JSON Lines、SSE 分帧与解析 | [数据格式与流式协议](packages/data-formats/README.md) |
| 路径安全、完整性、归档、生成物、配置包 | [制品与文件安全](packages/artifacts/README.md) |
| Git 文件发现、上下文规划、文本完整性、确定性源码快照 | [仓库工具](packages/repository-tooling/README.md) |
| Workspace 依赖图、pnpm 读取与循环检查 | [Workspace 工具](packages/workspace-tooling/README.md) |
| 进程发现、终止与受控命令执行 | [进程与命令执行](packages/process-execution/README.md) |

## 怎么阅读

先进入对应能力域的 README 做选型；确定 package 后，再阅读该 package 的中文页面。能力域 README 只解释“选哪个、怎么组合”，不会重复单包 API 和示例。

仓库级架构规则见 [架构与能力边界](architecture/boundaries.md)；发布流程见 [维护者发布手册](maintenance/releases.md)。
