---
"@openge/forge-release-vercel": minor
---

增加显式的 prebuilt 发布后完成阶段：在同一受管锁与原生进程生命周期内验证生产目标并运行有界幂等任务。未完成时保护原始输入，只有明确 verify 重试才追加尝试；保留原失败、关闭证明和已发生的发布副作用，不自动重复创建、绑定或 promote。
