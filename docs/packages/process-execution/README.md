# 进程与命令执行

这一组 package 把操作系统进程能力与命令生命周期分开，避免命令执行器直接绑定某一种平台实现。

## 怎么选

| 需求 | 使用 package |
| --- | --- |
| 只需要进程身份、TCP listener、终止策略和 Provider contract | [`@openge/forge-process-control`](process-control.md) |
| 需要 Windows/Posix 的实际进程发现与终止 Provider | [`@openge/forge-process-control-node`](process-control-node.md) |
| 需要异步启动单个命令、限制输出、超时、取消和受控终止 | [`@openge/forge-command-runner`](command-runner.md) |

`command-runner` 依赖中立 `process-control` contract，由调用方注入实际 Provider；它不直接依赖 `process-control-node`，因此平台选择始终显式。
