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

## 读取预算与验证证据

READ-INDEX v1 的 `assurance` 是历史格式能力声明：`normalized-text-verified` 表示 v2 格式能够进行规范化文本校验，不证明生成索引时读取或验证过正文。只有实际执行 Reader/verify 并保存其结果，才能声明相应范围的本次验证；索引不会生成 observed-verification receipt。

完整索引、路径视图和 preferred/reference profile 在一次调用内复用文件与对象查找表。视图仍检查全部源记录的结构与引用，但仅为选中路径投影展示记录；profile 两部分共用一次预处理。行数统计和 Markdown 渲染使用同一个逐行生成器，不为统计建立完整渲染字符串。旧 JSON 字段、排序和 Markdown 输出保持兼容；重复 manifest 路径现在明确返回 `DUPLICATE_PATH`，不再静默选取第一条记录。

Reader 在复制对象字节前核对路径集合、声明大小、实际大小与累计预算，随后保留防变更复制和正文完整性校验。实际字节或累计声明超限优先返回 `TEXT_READ_LIMIT_EXCEEDED`，而不是先分配大副本再返回完整性错误。此限制控制本次读取的额外分配，不能撤销调用方已经分配的输入。Node 读取入口先检查声明预算，再顺序有界读取对象；文件在 stat 后改变长度时拒绝本次读取并关闭句柄，不按增长后的长度扩大分配。

这些内部维护不引入跨调用缓存、云端回源、额外公开符号或新的正文格式。当前 `missing` 只表示所给 manifest 未收录该路径，不能据此判断原仓库不存在文件。

## 轻量阅读目录与固定摘要正文读取

根入口公开 buildSnapshotReadCatalog、resolveSnapshotCatalog、verifySnapshotReadCatalog 和 readSnapshotCatalogText。目录生成只使用显式 manifest/profile，生成独立 readRoot 的制品描述，不修改 SNAPSHOT、READ-INDEX、INDEX 或正文对象。CLI 保持原有命令，消费端通过这些 API 显式装配阅读层。

目录入口为 CATALOG.json 与 README.md；路径和对象反向引用使用确定性的 SHA-256 前缀树。入口最多 64 KiB、每个 JSON 分片最多 256 KiB（含 UTF-8 包装），超限递归拆分；单条记录或路由仍无法满足预算时明确拒绝，绝不截断。制品数量、总字节及 README 镜像共同计入预算。对象反向查询列出该包容纳的源路径，只有按 normalizedSha256 筛选后才表示同规范化正文别名。

首次发布必须完整比较 manifest 与目录，并固定根摘要；快捷查询只校验调用方固定的目录及所需分片，不能单靠自洽 hash 宣称已独立验证来源。未知 schema、错误路由、损坏分片失败关闭；缺片返回 needs-artifact，未收录路径返回 not-in-snapshot 且源路径存在性为 unknown。所有读取都由消费端显式提供内容，无云 SDK、隐式回源或自动下载。

目录提供原路径、source/normalized digest、对象需求和源行/字节 locator。源行号、对象字节位置与连接器行号不得混用。verificationCapabilities 只说明能力，生成和读取目录都不产生正文已验证证据。消费端在独立阅读目标发布前 pin 源快照，复用 generated-artifacts 发布与核验；仍有目录引用时不能解 pin。readSnapshotCatalogText 以调用方已核验并固定的 catalogDigest 为信任起点，不需要完整 manifest；它对所需目录分片和正文对象执行校验，并计算完整规范化文本摘要。该入口 maxTotalBytes 同时统计本次已验证目录与正文对象字节；来源信任及初次全量目录/manifest 核验成本必须单独记录。

## Retention 与删除

默认保留当前快照加最近快照，总数为 3；默认 orphan grace 为 7 天。显式 active pin 在基础 keepCount 集合之外追加保护，过期 pin 不保护；pin registry 使用 revision/CAS 并与 export/prune 共用同一把锁。对象重新被保留快照引用时，其 orphan 观察状态会被清除。managed-store 物理占用只统计 objects、snapshots 和 owner-managed 状态文件，共享 object 只计一次，人工目录不计入。

`pruneSourceSnapshots()` 在互斥锁内重新读取当前状态，并验证所有 retained snapshots 后才允许删除。删除后必须确认路径真实消失；Windows 下提供文件系统删除假成功的 fallback。GC state 或 managed store 结构异常时失败关闭。

回退到不认识 `.source-snapshot-pins.json` 的旧程序时，禁止由该旧程序执行 prune；已有 v2 对象与 pin 继续由理解当前 pin registry 的版本负责回收。包版本回退不能被视为 GC 状态自动安全回滚。

## 来源侧车与冻结绑定

来源侧车保持独立 schema，不改变 canonical snapshot ID 或原正文对象。仅有 manifest 的旧快照报告 captureMode、exporter、policy、fileStates 为 unknown/null，不从当前源树补写历史；仓库 HEAD 等原字段仅标为 manifest 声明。

内部同次采集装配先复制显式配置，再复用 prepare/freeze 门，从同一 plan 生成 coverage、catalog 与 provenance。逐文件状态只覆盖已保存正文：tracked/untracked、index/worktree 状态、staged 与未暂存修改；实际子仓 HEAD 与 parentGitlink 保留。发现漂移或阻断时拒绝并释放本次 spool。发布前仍须消费者执行原 freeze/pin/锁及入口切换约束；不保证多仓原子时间点。

单独提供已有 plan 的适配器把来源标为 supplied-records；同次装配标为 same-operation。生产者版本和配置摘要均是调用方声明，不是来源认证；未提供函数分组 producer/configDigest 时 reproducibility 保持 unknown，不以函数名或 toString 代替稳定语义。实际 group 决策单独参与摘要。policy摘要只含显式有效路径策略，不等于语言构建条件、所有外部环境或自定义验证函数的语义摘要。

公开报告不复制绝对路径、排除项名称、secret 内容或逐项敏感指纹；冻结身份只从已公开正文状态、仓库、policy与group摘要派生。来源、coverage、catalog均绑定同一 canonical manifest；复用 detached evidence 校验 provenance 字节。bodyVerification始终为 not-performed；hash一致不证明声明可信或网络操作发生。

根入口公开 buildSnapshotProvenance/verifySnapshotProvenance；Node 入口公开 buildSnapshotProvenanceFromPlan/prepareSnapshotWithProvenance。消费者只向独立阅读根发布派生制品，不向旧 snapshot 目录补写来源文件。

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

## 阅读策略与覆盖观察

覆盖报告使用独立 schema，以 snapshotId 与 canonical manifest digest 绑定当前输入。物理纳入状态、阅读优先级和调用方声明的 role 分开：reference 仍可保留完整正文；metadata-only、excluded 或 blocked 不承诺正文可读。报告本身不应用删除策略，不修改 manifest、objects 或旧快照。

纯计算生成器只接受显式决策与发现边界，默认没有完整发现证据。缺失路径在 unknown、git-listed、未初始化子模块或未采集范围内不能返回不存在；只有调用方提供可信的 all-paths 完整范围证据时才可按该次枚举判定范围内缺项，不代表已独立证明当下文件系统状态。未枚举候选数量为未知，不能用零表示。

采集适配器复用已给定的 inventory、分类决策、内容问题和 freeze。先检查 inventory fingerprint、正文 hash 与 repository 绑定，并核对显式 policy 与已产生的决策一致；随后派生报告，不重新遍历、读取或执行源码。policy digest 表示本次显式输入及其决策一致性，不把旧计划缺失的原始策略补写成已知。

敏感路径和 secret finding 默认只进入匿名计数，不出现在路径、角色、重复 profile 或边界列表中；存在隐藏候选时不据其缺席推断不存在。结构化错误不回显秘密路径或原始错误文本。LFS pointer 状态接受上层显式声明，不隐式下载 LFS 或从扩展名猜测。

当前版本先做观察：默认最多 200,000 个输入条目、64 MiB 报告，超限拒绝而非截断；largestEntries 仅是显式限定数量的大小排名，不代替完整 entry 集合。未收录候选、子树边界、逻辑源码字节与对象容器字节分开统计。分类规则与角色配置由消费者持有，不整类删除示例、JSON、类型声明或第三方目录。

旧快照只保留 manifest 时，仅生成 manifest-only 观察；其原始候选数量和历史排除理由仍未知。持久化报告应与完整输入重新绑定校验后使用；bodyVerification 固定为 not-performed，实际正文、云端清单与检索验证另存证据。

根入口公开 buildSnapshotCoverage/resolveSnapshotCoverage/verifySnapshotCoverage，Node 入口公开 buildSnapshotCoverageFromPlan。消费者可在独立 readRoot 组合发布 profile、catalog 与覆盖报告；切换入口前验证并 pin 来源，同时统计阅读目录和来源存储的全部成本。

## 非职责

根入口不得引入 Node/`ws` 依赖；Node-only 能力只允许从 `@openge/forge-source-snapshot/node` 暴露，并在 browser condition 下关闭。本包不反向发现消费者 plans/configuration，不扫描上层报告目录，不获取云端上下文，不启动后台 watcher，不负责定时任务，不直接调用 Google Drive、Dropbox、OneDrive、S3 等提供商 API，也不宣称本地写入等于云端同步完成。需要云同步时，由消费者在本包的本地 `LOCAL_VERIFIED` 之后执行自己的同步与 readback 门。
