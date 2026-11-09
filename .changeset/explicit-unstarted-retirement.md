---
"@openge/forge-release-vercel": minor
"@openge/forge-process-control-node": patch
---

为受管发布增加显式 `retire --run-id UUID --abandon-unstarted` 及 SDK `abandonUnstarted` 选项。仅当原 Windows 宿主、首 Git 未绑定身份、持久化空作用域、匹配失败回执和无 SDK 写入副作用等证据全部成立时，才归档原始 UNKNOWN 并允许重新开始；默认恢复和后续开机门禁保持不变。归档后重试仍重新确认原协调者退出。

保留受管进程的首个启动失败分类，并通过有界白名单诊断报告启动失败阶段，避免后续清理错误覆盖最初原因。
