# 变更记录

## 0.1.0

### Minor Changes

- f07a7de: 新增显式生成物生命周期、有界异步命令执行和确定性配置归档包。Node 能力独立导出，文件系统策略与进程 Provider 由调用者明确选择。配置导入验证摘要并报告尽力回滚结果，旧格式不静默导入。Repository Context 委托通用比较能力，同时保留现有公开行为。
  
  Path Safety 拒绝孤立 UTF-16 代理码元，防止文件系统编码将不同路径合并。Generated Artifacts 在 I/O 前拒绝计划内的文件与祖先冲突，并以实际 UTF-8 字节语义进行换行比较。
  
  Archive ZIP 保留文件名前导 BOM，并复用已校验的路径和偏移解码数据，保持文件名身份与资源上限。
  
  Archive Safety 与 Archive ZIP 精确依赖包含路径修复的后续 RC，保证独立安装也获得相同校验规则。

### Patch Changes

- Updated dependencies [f07a7de]
  - @openge/forge-path-safety@0.1.1
  - @openge/forge-archive-zip@0.1.1
  - @openge/forge-archive-safety@0.1.1

## 0.1.0-rc.1

- 准备通过 GitHub Actions Trusted Publishing 发布带 provenance 的 RC；精确依赖修复文件名身份和路径校验的 Archive ZIP、Archive Safety 与 Path Safety 版本。

## 0.1.0-rc.0

- 新增确定性 ZIP 与 Manifest V1、路径及资源限制、条目集合和 SHA-256 验证。
- 新增显式大小写策略、导入预检查、冲突聚合与三种覆盖策略。
- 新增同目录暂存与原子发布、独占备份、尽力回滚及逐路径诊断。
- 补充真实文件系统故障、竞态与打包消费者验证；浏览器入口不加载 Node.js API。
