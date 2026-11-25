---
"@openge/forge-process-control-node": patch
---

修复 Windows Job 同时回收多个成员时的关闭证明竞态。完整清单确认某个已退出成员消失后，继续验证其余成员、已持有的进程句柄和最终活跃计数。
