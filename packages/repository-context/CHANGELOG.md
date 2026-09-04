# @openge/forge-repository-context

## 0.1.0

### Minor Changes

- 2b1a98a: 新增领域中立的 Repository Context 基础能力，并提供真实 tarball 消费验证。

### Patch Changes

- f07a7de: 新增显式生成物生命周期、有界异步命令执行和确定性配置归档包。Node 能力独立导出，文件系统策略与进程 Provider 由调用者明确选择。配置导入验证摘要并报告尽力回滚结果，旧格式不静默导入。Repository Context 委托通用比较能力，同时保留现有公开行为。
  
  Path Safety 拒绝孤立 UTF-16 代理码元，防止文件系统编码将不同路径合并。Generated Artifacts 在 I/O 前拒绝计划内的文件与祖先冲突，并以实际 UTF-8 字节语义进行换行比较。
  
  Archive ZIP 保留文件名前导 BOM，并复用已校验的路径和偏移解码数据，保持文件名身份与资源上限。
  
  Archive Safety 与 Archive ZIP 精确依赖包含路径修复的后续 RC，保证独立安装也获得相同校验规则。
- Updated dependencies [f07a7de]
  - @openge/forge-generated-artifacts@0.1.0

## 0.1.0-rc.1

- 通过 Trusted Publishing 发布新 RC，并精确依赖 Generated Artifacts 的后续 RC。
- 通用输出比较委托 Generated Artifacts Core，保留任意字符串输出键、CRLF/CR/LF 比较、missing/stale/unexpected 以及原始字符串区别。

## 0.1.0-rc.0

### Minor Changes

- 新增领域中立的 registry 校验、稳定去重、选择、闭包、预算诊断和确定性输出比较。
