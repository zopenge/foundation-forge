# Source Snapshot

`@openge/forge-source-snapshot` 是领域中立的 Git 源码快照基础包，用于把本地源码仓库转换为可验证、可增量复用、适合 AI 分析的内容寻址快照。

## 分层职责

根入口保持运行时中立，负责 manifest、变更比较、policy、文本解码、secret 扫描、版本化文本 packing、v2 规范化完整性、同 group 且与逻辑路径无关的精确 content-block 去重、逻辑/唯一正文/对象容器字节指标、READ-INDEX 派生、阅读 profile、已采集 relations 的中立校验、detached evidence 的结构/source 绑定校验、已发布对象重建校验和 pin-aware retention 规划。

`@openge/forge-source-snapshot/node` 显式提供 Node 能力：

- 根仓库与已初始化 submodule inventory；
- tracked + 非忽略 untracked 文件发现；
- submodule gitlink/HEAD 一致性门；默认严格要求一致，聚合开发工作区可显式选择当前 checkout HEAD，并保留父 gitlink 来源证据；
- repository plan、freeze-check 和 export orchestration；
- 面向大仓库的有界工作集 prepared pipeline：正文与 packed object 使用临时磁盘 spool，CLI `plan` / `export` 不要求全量源码与对象正文同时驻留 V8 heap；
- ownership、lock、本地发布与 objects/text 分级 verify；
- 仅基于已发布 store 的 read/unpack，不依赖原 sourceRoot 或消费者配置；
- 显式 pin registry（revision/CAS）与 managed-store 物理占用/发布预算；
- retention status、prune、orphan GC；
- CLI runner。

阅读 profile 只对已导出路径做 preferred/reference 分类与覆盖状态派生；relations 只校验调用方已采集声明的 snapshot/path/sourceSha 绑定，不自动抓取 unresolved/external 目标，也不从“无关系”推断 unused/dead。Evidence 只验证 schema、snapshot 绑定与调用方显式提供的 artifact bytes/hash；返回 `schema-valid` / `source-bound` 不等于独立证明测试、命令、运行时观测或云操作真实发生。metadata 中的 command/URL/script 仅作为脱敏字符串，不执行、不访问、不自动 pin。

消费者负责自己的 policy、grouping、target/state 路径、managed-store 发布预算、项目脚本、调度方式和云端 readback；Foundation 不内置任何具体仓库、产品或云存储提供商语义。

## 核心契约

`createSnapshotManifest()` 的身份绑定 project/policy、repository HEAD/branch/dirty、文件字节完整性、对象引用和 coverage 元数据；发布时间不参与 snapshot identity。

`compareSnapshotFiles()` 按路径和字节完整性比较新增、修改、删除。重命名保持确定性地表示为旧路径删除和新路径新增，不做语义 rename 推断。

`planRepositorySnapshot()` 先完成 inventory、consumer policy 分类、secret gate、文本 decoding、packing 和 manifest 生成。出现 review、secret、内容错误或 submodule blocker 时返回 `BLOCKED`，不得发布。submodule 默认使用 `submoduleHeadPolicy: 'require-gitlink'` 的严格语义；只有消费者明确配置 `submoduleHeadPolicy: 'allow-checked-out'` 时，已初始化但 HEAD 与父 gitlink 不一致的 submodule 才允许进入快照。此模式仍以实际 checkout HEAD 参与 snapshot identity，并在不一致时把父引用写入 manifest 的 `parentGitlink`，不会静默丢失漂移来源；未初始化 submodule 或缺失 gitlink 仍然阻断。

`exportRepositorySnapshot()` 保留为纯内存 bundle 的兼容 API；Node CLI 默认使用 prepared-spool 路径，在逐文件读取、secret 检查和 freeze 记录后把唯一正文落入临时 spool，再以有界 object 批次发布。两条路径都在 publication 前再次校验 frozen input；prepared 路径完成或失败后必须清理临时 spool。

发布顺序为：content-addressed objects → snapshot metadata → 本地完整性验证 → current entry 最后切换。发布结果分别报告 `bytesWritten` 与 `objectsReused`；v2 alias 增删不会改变共享 content-block 的对象身份。相同 snapshot 再次导出返回 `NO_CHANGES`；A→B→A 时，若历史 A 的 canonical manifest、objects 与文本验证仍通过，只重新激活 entry，不重写 A 的不可变 SNAPSHOT/READ-INDEX/INDEX/CHANGES。

## Retention 与删除

默认保留当前快照加最近快照，总数为 3；默认 orphan grace 为 7 天。显式 active pin 在基础 keepCount 集合之外追加保护，过期 pin 不保护；pin registry 使用 revision/CAS 并与 export/prune 共用同一把锁。对象重新被保留快照引用时，其 orphan 观察状态会被清除。managed-store 物理占用只统计 objects、snapshots 和 owner-managed 状态文件，共享 object 只计一次，人工目录不计入。

`pruneSourceSnapshots()` 在互斥锁内重新读取当前状态，并验证所有 retained snapshots 后才允许删除。删除后必须确认路径真实消失；Windows 下提供文件系统删除假成功的 fallback。GC state 或 managed store 结构异常时失败关闭。

回退到不认识 `.source-snapshot-pins.json` 的旧程序时，禁止由该旧程序执行 prune；已有 v2 对象与 pin 继续由理解当前 pin registry 的版本负责回收。包版本回退不能被视为 GC 状态自动安全回滚。

## CLI

默认配置文件为仓库当前目录的 `source-snapshot.config.mjs`，也可用 `--config` 指定：

```sh
forge-source-snapshot plan --json
forge-source-snapshot export --json
forge-source-snapshot verify --json
forge-source-snapshot status --json
forge-source-snapshot prune --dry-run --json
forge-source-snapshot prune --json
forge-source-snapshot read --target-root <store> --owner-id <owner> --path <file> --json
forge-source-snapshot unpack --target-root <store> --owner-id <owner> --output <dir> --json
```

CLI 的 JSON 结果只输出状态、路径清单和统计元数据，不输出 packed source 正文或 secret 值。消费者可以直接调用 `runSourceSnapshotCli()`，返回 `{ exitCode, result }` 用于自动化。

## 非职责

根入口不得引入 Node/`ws` 依赖；Node-only 能力只允许从 `@openge/forge-source-snapshot/node` 暴露，并在 browser condition 下关闭。本包不反向发现消费者 plans/configuration，不扫描上层报告目录，不获取云端上下文，不启动后台 watcher，不负责定时任务，不直接调用 Google Drive、Dropbox、OneDrive、S3 等提供商 API，也不宣称本地写入等于云端同步完成。需要云同步时，由消费者在本包的本地 `LOCAL_VERIFIED` 之后执行自己的同步与 readback 门。
