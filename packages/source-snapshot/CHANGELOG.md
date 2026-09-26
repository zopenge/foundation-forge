# @openge/forge-source-snapshot

## 0.2.2

### Patch Changes

- Updated dependencies [aae44f3]
  - @openge/forge-deterministic-json@0.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [665bd93]
  - @openge/forge-generated-artifacts@0.1.1

## 0.2.0

### Minor Changes

- fe3794c: 公开有界阅读目录、覆盖说明和来源侧车合同，增加基于固定目录摘要的正文读取，避免普通冷读先加载全量 manifest。
  
  读取链复用文件与对象查找表，在额外字节复制与 Node 读盘前执行预算预检，保留规范化文本校验、旧索引字段和正文对象兼容性。
  
  来源、覆盖和目录显式绑定同一快照；旧来源缺项保持未知。云端认证、同步、回读和重试仍由消费端负责，不向核心包引入云 SDK 或隐式回源。

## 0.1.3

### Patch Changes

- 9bb63bb: 为聚合开发工作区增加显式 `submoduleHeadPolicy: 'allow-checked-out'` 模式：默认仍严格要求 submodule HEAD 与父 gitlink 一致；显式启用后使用实际 checkout HEAD 生成快照，并在不一致时把父 gitlink 作为 `parentGitlink` 来源证据写入 manifest。
  
  同时重构 Node repository/CLI 的大仓处理链：使用临时磁盘 spool 与有界 object 批次替代全量 decoded source / packed object 常驻内存，并消除 packing、manifest 构建中的二次复杂度热点；保留 runtime-neutral 纯内存 API 作为兼容入口。

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
