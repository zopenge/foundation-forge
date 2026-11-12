---
"@openge/forge-repository-files": patch
---

Git 查询在取消或启动失败后等待真实 `close` 再返回错误，避免调用方收到拒绝后仍与进程竞争文件清理。stdin 模式同时接收管道错误并保留进程首错；原取消、退出码与输出断言保持。
