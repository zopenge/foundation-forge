---
"@openge/forge-repository-context": patch
---

修复本地 generation 快照无界累积：成功构建只保留当前快照，持锁回收历史与中断暂存，失败或取消时保护已提交索引。补齐精确引用淘汰诊断、并发读取重试、路径和链接边界，并验证真实 tarball 的反复构建生命周期。
