# @openge/forge-command-runner

## 0.1.0

### Minor Changes

- f07a7de: 新增显式生成物生命周期、有界异步命令执行和确定性配置归档包。Node 能力独立导出，文件系统策略与进程 Provider 由调用者明确选择。配置导入验证摘要并报告尽力回滚结果，旧格式不静默导入。Repository Context 委托通用比较能力，同时保留现有公开行为。
  
  Path Safety 拒绝孤立 UTF-16 代理码元，防止文件系统编码将不同路径合并。Generated Artifacts 在 I/O 前拒绝计划内的文件与祖先冲突，并以实际 UTF-8 字节语义进行换行比较。
  
  Archive ZIP 保留文件名前导 BOM，并复用已校验的路径和偏移解码数据，保持文件名身份与资源上限。
  
  Archive Safety 与 Archive ZIP 精确依赖包含路径修复的后续 RC，保证独立安装也获得相同校验规则。

## 0.1.0-rc.1

- 准备通过 GitHub Actions Trusted Publishing 发布带 provenance 的 RC，保留已验证的异步命令契约与生命周期行为。

## 0.1.0-rc.0

### 新增

- 提供纯异步命令执行契约、规范化与结构化诊断，以及显式注入 Process Control Provider 的 Node 入口。
- 支持 stdout/stderr 字节事件、有界捕获、超时、心跳、AbortSignal 与幂等终止。
- 对身份观察和终止操作分别设置显式期限，覆盖 Provider 拒绝、挂起及进程退出竞态，并清理定时器、监听器与进程流资源。
- 为进程退出后仍被后代持有的输出管道设置显式关闭预算，超时仅释放自身流并报告结构化失败。
