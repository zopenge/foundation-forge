# @openge/forge-path-safety

## 0.1.1

### Patch Changes

- f07a7de: 新增显式生成物生命周期、有界异步命令执行和确定性配置归档包。Node 能力独立导出，文件系统策略与进程 Provider 由调用者明确选择。配置导入验证摘要并报告尽力回滚结果，旧格式不静默导入。Repository Context 委托通用比较能力，同时保留现有公开行为。
  
  Path Safety 拒绝孤立 UTF-16 代理码元，防止文件系统编码将不同路径合并。Generated Artifacts 在 I/O 前拒绝计划内的文件与祖先冲突，并以实际 UTF-8 字节语义进行换行比较。
  
  Archive ZIP 保留文件名前导 BOM，并复用已校验的路径和偏移解码数据，保持文件名身份与资源上限。
  
  Archive Safety 与 Archive ZIP 精确依赖包含路径修复的后续 RC，保证独立安装也获得相同校验规则。

## 0.1.1-rc.0

- 拒绝含孤立 UTF-16 代理码元的 portable path，避免文件系统编码导致路径别名；合法代理对保持不变。

## 0.1.0

### Minor Changes

- 61fa170: Add portable relative-path validation and explicit Node.js root containment.

## 0.1.0-rc.1

Publish the first release candidate through npm Trusted Publishing after the
one-time package bootstrap.

## 0.1.0-rc.0

Initial release candidate with portable relative-path validation and explicit
Node.js root containment.
