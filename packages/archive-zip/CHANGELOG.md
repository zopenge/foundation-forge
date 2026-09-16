# @openge/forge-archive-zip

## 0.1.1

### Patch Changes

- f07a7de: 新增显式生成物生命周期、有界异步命令执行和确定性配置归档包。Node 能力独立导出，文件系统策略与进程 Provider 由调用者明确选择。配置导入验证摘要并报告尽力回滚结果，旧格式不静默导入。Repository Context 委托通用比较能力，同时保留现有公开行为。
  
  Path Safety 拒绝孤立 UTF-16 代理码元，防止文件系统编码将不同路径合并。Generated Artifacts 在 I/O 前拒绝计划内的文件与祖先冲突，并以实际 UTF-8 字节语义进行换行比较。
  
  Archive ZIP 保留文件名前导 BOM，并复用已校验的路径和偏移解码数据，保持文件名身份与资源上限。
  
  Archive Safety 与 Archive ZIP 精确依赖包含路径修复的后续 RC，保证独立安装也获得相同校验规则。
- Updated dependencies [f07a7de]
  - @openge/forge-archive-safety@0.1.1

## 0.1.1-rc.0

- 精确依赖使用新版路径规则的 Archive Safety。
- 保留 UTF-8 文件名前导 BOM，并复用已验证的中央目录路径逐项解码，避免合法文件名别名和配置归档往返失败。

## 0.1.0

### Minor Changes

- 90357aa: Add domain-neutral archive, streaming protocol, workspace graph, and process control capabilities with explicit Providers. Process control includes process inspection and separate single-process and process-tree termination, while pnpm workspace discovery handles nested containers and overlapping patterns.

## 0.1.0-rc.1

### Minor Changes

- Publish the first Trusted Publishing release candidate after registry bootstrap.

## 0.1.0-rc.0

### Minor Changes

- Add deterministic ZIP32 encoding, bounded inspection, and safe in-memory decoding.
