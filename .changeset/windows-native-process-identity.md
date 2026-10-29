---
"@openge/forge-process-control-node": minor
---

新增显式 Windows 原生进程身份读取器，使用受限进程句柄绑定 PID、创建时间与存活状态，避免逐次启动查询进程；保持取消、身份校验、结构化错误及句柄关闭约束，不引入自动回退。
