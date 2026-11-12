---
"@openge/forge-artifact-publish": minor
"@openge/forge-artifact-publish-cos": patch
---

将制品内容身份改为必需的清单 SHA-256 与可选真实 Git provenance，支持没有 Git 仓库的生产者。新增规范清单 v1 生成入口，绑定路径、摘要、长度、响应策略及控制文件。

这是 0.x 破坏性契约调整：移除 `sourceCommit` 输入，操作记录和对象发布回执升级为 schema 2，旧未知记录拒绝自动迁移或重放。Node 命令关联环境同步更新，并保留受管作用域与确认关闭要求。

迁移 COS 消费契约，增加真实 tarball 的 Node 与严格非 Node workerd/SQLite 重启恢复验收；pending、只读恢复、稳定 reference 与 CAS 仍保持单次操作语义。
