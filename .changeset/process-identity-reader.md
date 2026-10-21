---
"@openge/forge-process-control": minor
"@openge/forge-process-control-node": minor
---

新增独立的 ProcessIdentityReader 窄契约及显式 Windows/POSIX 工厂，仅读取指定 PID 和启动标识。Windows 通过 .NET Process/Console 读取真实创建时间并保留既有 CIM JSON-date token，POSIX 沿用 ps；命令无法启动、权限失败、身份无法确认或无效启动标识均以结构化错误拒绝，不将不确定状态视为进程不存在；完整进程查询与终止接口保持原有行为。
