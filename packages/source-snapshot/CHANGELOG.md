# @openge/forge-source-snapshot

## 0.1.2

### Patch Changes

- 2380ab8: 修复 CLI 通过 pnpm/node_modules 链接路径执行时误判为非直接调用、从而静默 exit 0 且不执行命令的问题，并在真实 tarball consumer 中加入链接路径回归验证。

## 0.1.1

### Patch Changes

- 42e9a27: 修复 source-snapshot CLI 配置未转发 managed-store 发布预算的问题；consumer 现在可以通过 `storeBudget.maxManagedFiles` 与 `storeBudget.maxManagedBytes` 保留与 Node API 一致的发布前物理存储门禁。

## 0.1.0

### Minor Changes

- 131090f: 新增领域中立的 Git 源码快照能力：包含仓库与子模块清单、调用方策略与分组、敏感信息门禁、确定性内容打包、同 group 且与逻辑路径无关的 content-block 精确去重与独立物理收益指标、阅读 profile、已采集 relations 中立校验、detached evidence 结构/source 绑定校验、v2 已发布对象读取/解包、冻结校验、安全发布、objects/text 分级验证、显式 pin、物理存储预算、保留与 GC，以及 CLI 与真实 tarball consumer 验证。

### Patch Changes

- Updated dependencies [f07a7de]
  - @openge/forge-generated-artifacts@0.1.0
  - @openge/forge-path-safety@0.1.1

## 0.1.0-rc.0

### Minor Changes

- Add provider-neutral Git source snapshot planning, packing, publication, verification, retention, pruning and CLI workflows.
- Keep repository policy, grouping, storage synchronization and cloud readback in the consuming repository.
- Validate real tarball consumers, Git submodules, frozen inputs, secret gates and confirmed filesystem deletion.
