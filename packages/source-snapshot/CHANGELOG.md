# @openge/forge-source-snapshot

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
