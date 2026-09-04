# 更新日志

## 0.1.0

### Minor Changes

- f07a7de: 新增显式生成物生命周期、有界异步命令执行和确定性配置归档包。Node 能力独立导出，文件系统策略与进程 Provider 由调用者明确选择。配置导入验证摘要并报告尽力回滚结果，旧格式不静默导入。Repository Context 委托通用比较能力，同时保留现有公开行为。
  
  Path Safety 拒绝孤立 UTF-16 代理码元，防止文件系统编码将不同路径合并。Generated Artifacts 在 I/O 前拒绝计划内的文件与祖先冲突，并以实际 UTF-8 字节语义进行换行比较。
  
  Archive ZIP 保留文件名前导 BOM，并复用已校验的路径和偏移解码数据，保持文件名身份与资源上限。
  
  Archive Safety 与 Archive ZIP 精确依赖包含路径修复的后续 RC，保证独立安装也获得相同校验规则。

### Patch Changes

- Updated dependencies [f07a7de]
  - @openge/forge-path-safety@0.1.1

## 0.1.0-rc.1

- 准备通过 GitHub Actions Trusted Publishing 发布带 provenance 的 RC；精确依赖修复孤立代理码元路径校验的 Path Safety 版本。

## 0.1.0-rc.0

- 新增显式生成物计划、防御性复制、确定性排序及字节或文本换行比较。
- 新增独立 Node 入口，支持显式大小写策略、路径预检、同目录原子写入和退休文件删除。
- 新增 symlink/junction 拒绝、提交前复检、结构化失败与安全清理诊断。
- 根入口保持无 Node 依赖；包消费验证覆盖真实 tarball、浏览器边界与文件发布。
- 修复文件与祖先路径计划冲突的零 I/O 预检；复用共享路径层拒绝孤立代理码元路径。
- 修复文本换行比较与 UTF-8 写入语义不一致导致重复发布的问题。
