# Source Snapshot

`@openge/forge-source-snapshot` 是领域中立的 Git 源码快照基础包，用于把本地源码仓库转换为可验证、可增量复用、适合 AI 分析的内容寻址快照。

## 分层职责

根入口保持运行时中立，负责 manifest、变更比较、policy、文本解码、secret 扫描、完整文本 packing、重建校验和 retention 规划。

`@openge/forge-source-snapshot/node` 显式提供 Node 能力：

- 根仓库与已初始化 submodule inventory；
- tracked + 非忽略 untracked 文件发现；
- submodule gitlink/HEAD 一致性门；
- repository plan、freeze-check 和 export orchestration；
- ownership、lock、本地发布与完整性 verify；
- retention status、prune、orphan GC；
- CLI runner。

消费者负责自己的 policy、grouping、target/state 路径、项目脚本、调度方式和云端 readback；Foundation 不内置任何具体仓库、产品或云存储提供商语义。

## 核心契约

`createSnapshotManifest()` 的身份绑定 project/policy、repository HEAD/branch/dirty、文件字节完整性、对象引用和 coverage 元数据；发布时间不参与 snapshot identity。

`compareSnapshotFiles()` 按路径和字节完整性比较新增、修改、删除。重命名保持确定性地表示为旧路径删除和新路径新增，不做语义 rename 推断。

`planRepositorySnapshot()` 先完成 inventory、consumer policy 分类、secret gate、文本 decoding、packing 和 manifest 生成。出现 review、secret、内容错误或 submodule blocker 时返回 `BLOCKED`，不得发布。

`exportRepositorySnapshot()` 在 plan 后再次校验源码字节，防止计划与写入之间发生同尺寸或其他源码变化；只有 frozen input 仍一致才进入 publication。

发布顺序为：content-addressed objects → snapshot metadata → 本地完整性验证 → current entry 最后切换。相同 snapshot 再次导出返回 `NO_CHANGES`。

## Retention 与删除

默认保留当前快照加最近快照，总数为 3；默认 orphan grace 为 7 天。对象重新被保留快照引用时，其 orphan 观察状态会被清除。

`pruneSourceSnapshots()` 在互斥锁内重新读取当前状态，并验证所有 retained snapshots 后才允许删除。删除后必须确认路径真实消失；Windows 下提供文件系统删除假成功的 fallback。GC state 或 managed store 结构异常时失败关闭。

## CLI

默认配置文件为仓库当前目录的 `source-snapshot.config.mjs`，也可用 `--config` 指定：

```sh
forge-source-snapshot plan --json
forge-source-snapshot export --json
forge-source-snapshot verify --json
forge-source-snapshot status --json
forge-source-snapshot prune --dry-run --json
forge-source-snapshot prune --json
```

CLI 的 JSON 结果只输出状态、路径清单和统计元数据，不输出 packed source 正文或 secret 值。消费者可以直接调用 `runSourceSnapshotCli()`，返回 `{ exitCode, result }` 用于自动化。

## 非职责

本包不启动后台 watcher，不负责定时任务，不直接调用 Google Drive、Dropbox、OneDrive、S3 等提供商 API，也不宣称本地写入等于云端同步完成。需要云同步时，由消费者在本包的本地 `LOCAL_VERIFIED` 之后执行自己的同步与 readback 门。
