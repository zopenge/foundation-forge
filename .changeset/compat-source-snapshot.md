---
"@openge/forge-source-snapshot": minor
---

删除源码文本 v1 的打包、解析与索引兼容路径，省略格式配置时统一使用 v2；旧格式输入明确拒绝。

删除纯内存仓库 plan/export API，仓库采集统一使用 prepared-spool API 并保留 frozen-input 校验；迁移包内调用方与真实 tarball 消费者。删除 publication 的 reusedObjects 别名，API 与 CLI 统一使用 objectsReused。

本次包含公开破坏性变更；manifest-only 来源未知语义、显式 objects 验证和现行独立记录 schema 保持有效。
