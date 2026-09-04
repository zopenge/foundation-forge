# @openge/forge-command-runner

## 0.1.0-rc.1

- 准备通过 GitHub Actions Trusted Publishing 发布带 provenance 的 RC，保留已验证的异步命令契约与生命周期行为。

## 0.1.0-rc.0

### 新增

- 提供纯异步命令执行契约、规范化与结构化诊断，以及显式注入 Process Control Provider 的 Node 入口。
- 支持 stdout/stderr 字节事件、有界捕获、超时、心跳、AbortSignal 与幂等终止。
- 对身份观察和终止操作分别设置显式期限，覆盖 Provider 拒绝、挂起及进程退出竞态，并清理定时器、监听器与进程流资源。
- 为进程退出后仍被后代持有的输出管道设置显式关闭预算，超时仅释放自身流并报告结构化失败。
