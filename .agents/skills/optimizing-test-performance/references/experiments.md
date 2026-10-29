# 已有实验与适用边界

本记录保存截至 2026-10-27 的可复核摘要。适用于继续此测试性能任务；未来实现或授权变化时重新核实，不把历史观察当永久性能保证。工作区默认为 `dev`，遵循根 AGENTS；技能不授权提交、推送、main 集成、发布、部署或 CI dispatch。

此技能最初创建批次的明确授权是“纯文档验证不要运行重测试”“新批暂不自动 commit/push”；当时只做文档与检索验证。该例外不自动适用于以后任务；后续夹具接入已明确授权组合一次原完整验收，但仍未授权提交推送。当前 `check-mode.mjs` 不把 `.agents/` 归为 docs，未忽略的技能文件会进入指纹并触发 full；技能文字不改变这段调度逻辑。文件被批准提交后，未来 checkout 才能发现它们。

## 已保留的改动

| 固定提交 | 结论与质量边界 | 已保存的计时口径 |
|---|---|---|
| `9141224cb9abad775186662355a45e18cdaab19b` | 同一次管理路径观察合并 HEAD/index 查询；每个 guard 仍重新执行，保留祖先、暂存删除及 Windows 大小写处理 | 原完整 3084.45 秒 → 2800.54 秒；后者外部墙钟 2803.2428507 秒。旧布局与后续双 worker 布局不可直接归因比较 |
| `da5b8964d06aa5f37eefe4a4228cfd6a437a2b29` | 一次 porcelain-v2 status 读取候选分支/HEAD/脏状态；组件只读查询分层与消费者矩阵去重。真实变更、未知命令、完整发布、崩溃与恢复继续保留 | `VITEST_MAX_WORKERS=1 pnpm check` 内部 1728.11 秒，外部 1729.3245127 秒，exit 0；248 脚本测试、1398 包测试通过，原有 3 项平台跳过 |
| `b6c82244fcd9afb3990b09327dcf199c8c8651f9` | 全链共享两个真实 worker；构建一次；隐藏窗口、父侧退出后释放槽、异常收尾失败；重阶段顺序执行；覆盖率暂存/回滚 | `pnpm check` 完整分支外部 1318.0361673 秒，exit 0；44 脚本文件/316 通过，27 包/1398 通过，原有 3 跳过；95 受管任务全部正常关闭且为空 |
| `96cd5c8c1b2124de96c112c4b8447ef12210f515` | 9 个测试/说明文件。预算夹具仅准备真实目录/身份/锁；三个组件文件使用新鲜的已提交来源准备，保留原受管 session 与故障行为。无生产改动 | 局部预算 13 测试 40.486823 → 3.6535484 秒；terminal 13 测试 73.5342507 → 59.4738183 秒。完整 1302.7499428 秒，见下节 |

实现证据：上述 Git diff、[查询合并与候选观察的发布记录](../../../../packages/release-vercel/CHANGELOG.md)、[测试分层说明](../../../../packages/release-vercel/tests/README.md)、[验证契约](../../../../docs/maintenance/validation.md)。源码本身不证明历史计时；下列摘要取自当次保存的终态报告。

### 最近一次正式全量

输入字节随后成为 `96cd5c8…`，相对 `b6c8224…` 的 9 个文件在提交前逐项核对 Git blob；1012 个验收输入未变。文件映射 SHA256：`1755f90f1ee170242f643ffe50defaca2edcf2b28ba71089191ee73e5a2013aa`。

- Windows、本机原 pnpm 10.33.2，`FORGE_CHECK_TEST_WORKERS=2 pnpm check` 进入完整分支；原命令还显式选择已批准的 pnpm store，未改变依赖。隐藏启动器 session `68014`。
- UTC `2026-10-26T23:40:31.0532820Z` → `2026-10-27T00:02:13.8032248Z`，外部 **1302.7499428 秒**，exit 0。相对上一全量仅少 **15.2862245 秒 / 1.16%**，未达到 300 秒。
- 44 脚本文件、316 通过；27 包、188 文件、1402 通过、原有 3 项 Windows 平台跳过。release 为 37 文件、261 通过；新加 4 项夹具测试，未删原测试。
- 95 个受管任务均 `closed / normal / empty=true`；52 个预算预约全部结束，真实峰值 2、active 0、remaining 空。lint 零错误零警告；类型、循环依赖、浏览器边界、真实 tarball 通过。
- release 的 39 个生产覆盖文件，已有 2168 statement / 307 function / 1846 branch 命中点无损；覆盖数字不能单独替代失败机制映射。
- 阶段秒数：lint 16.20；pack 251.69；type 12.46；cycles 0.76；scripts 83.76；coverage 936.25（release 794.0116911，其余约 142.24）。
- release coverage 842.35 → 794.01 秒；consumer install 19.83 → 53.44 秒的波动抵消部分收益。release smoke 本次 167.0294472 秒，总 smokes 176.14 秒。旧 151.85 秒 smoke 使用不同并发，不能当同条件回归。

补充原始证据位于 ignored `.tmp/astra-test-performance-20261026/`（`final-delivery.json`、`final-audit.json`、`experiment-summary.json`、`precommit-proof.json`），完整 context 为 `.tmp/check-runs/run-wmhjIH/`。旧报告在 `.tmp/check-performance-20261026/` 与 `.tmp/test-budget-integration-20261026/`。这些不是测试运行前提；清理后仍可用固定提交和本文摘要恢复决策，历史数字无法重算时明确说明。

## 已撤回、否决与不能外推的结论

| 状态 | 方案、证据与重试判据 |
|---|---|
| **已试无收益，撤回** | 在 `cae1dad01b42cbf370abf7c2322b71a8dbdd2107` 基线上用 Koffi 原生调用替换 Windows 身份 reader。隔离墙钟 90.107 → 92.053 秒；去掉 PowerShell 启动未改善该用例，未提交。采样运行 85.96 秒属于另一口径，不可挑选作收益。只有新的关键路径证据或实质不同机制才重开，不能仅凭 PowerShell 累计时间再次实施。证据：旧 `decision.json`、`native-identity-experiment/` |
| **设计 No-Go，未实施** | 在 `b6c8224…` + 上述 9 文件上考虑将 checkout 的 5 条查询放进一个 owned host。它省掉后续每命令的授权/持久化门禁；第一条查询后管理目录变为被跟踪时，可能先执行后续 argv 再拒绝。恢复各门禁又保留主成本。这只否决该批次缓存/门禁削减方案，不否决新的单操作算法合并或合理测试分层 |
| **不能冒充优化** | 增加 worker、删测试/扩大 skip、缩小 coverage、放宽原 1 秒自然退出判定、简化 observer 或把强制清空记作正常成功。现有质量/资源边界继续有效 |
| **不能直接相加** | 一次完整受管发布 `check` 用例（不是全仓 `pnpm check`）的 profile：439 次管理查询 21.665 秒；543 次 PowerShell 累计 37.969 秒、区间并集 33.497 秒；37 个 Node 宿主累计 27.534 秒。彼此大量重叠，全部外部进程并集约 46.684 秒；宿主含等待/执行，不是纯启动成本。505 次身份进程 exit=null 与短 Git 结束取消相符，但不是完整信号证据 |

该采样在 `b6c8224…` 基线阶段，逻辑命令为 `pnpm --filter @openge/forge-release-vercel run test:coverage --config <临时采样包装> tests/managed-release.test.ts -t "checks an unpublished committed input"`；原 context/observer、真实峰值 1、正常关闭且为空。UTC 23:13:33.842 → 23:14:33.592（2026-10-26），用例 56.900 秒、受管任务 59.749 秒。统计只使用同一 worker 的时钟，未把不同 PID 的相对时间拼接。诊断记录固定了三个安全实现文件哈希，未保存完整工作区指纹，不能视作与正式全量完全同条件。Koffi 撤回补丁只留 ignored 历史，其 SHA256 为 `cd630184e77b5241f3b5e5a7b2142d1b9b4a6141cd73b6c37b6326578f1064c3`；本文不携带该原型，不能单靠摘要复现实验代码。

439 次查询可由代码与单例 coverage 复核：315 store guard + 113 lifecycle guard + 5 checkout lock + 4 archive + 1 release + 1 admission。37 个受管命令各有 4 次持久化，每次 2 个原子写 guard，另有 3 个 lifecycle guard，即 `37×11+32=439`。跨异步回调、fsync/rename、真实命令的观察不是安全缓存候选。完整的管理跟踪回归位于 `tests/management-tracking.test.ts`。

**条件性成本界限**：最近全量其余阶段速度不变时，令 release coverage 与 release smoke 全部归零，仍约 341.71 秒；连安装回到旧 19.83 秒也约 308.10 秒。此算法乐观地减去有重叠的整个 smoke，只能说明“只优化 release 不够”，不能证明跨阶段优化永远无法达到 5 分钟。

## 尚未证明的风险与访问边界

- **已复现的受限上下文 taskkill 访问拒绝**：2026-10-27 的原 MCP 请求超时关闭单例中，taskkill 返回 status 1，错误输出脱敏类别为 `ACCESS_DENIED`；Node spawn error 为 null，没有 `error.code/syscall`，不能改写成 Node EPERM。这是已有失败风险的再次实测，不能因脚本未改动而忽略。具体单例与审批上下文对照见末节；不得用重试、另一终止机制或放宽关闭判定绕过。原测试既有 fixture 清理最终成功也不等于 MCP probe 正常关闭。
- 历史 `EPERM / syscall=rename` 与 Vitest worker 已退出而 Job 仍有后代，最终通过不代表根因已修复。诊断仅记录错误时元数据角色及本任务 Job 内成员 PID/创建标识/映像 basename；没有以猜测性重试掩盖错误，也没有把诊断副本改成生产实现。
- 此性能任务已有**全局 CIM 枚举拒绝**；只核本任务 Job 或已知归属 PID，不触碰旧 PID119448、用户进程或共享缓存。仓库存在其他 CIM 实现不构成本会话授权；技能不能绕过拒绝。新的权限需求走支持的审批，结果不确定先核执行状态。
- 不改系统安全、网络、杀毒、凭据、权限，不使用 RDC。继续隐藏子进程窗口；两个测试 worker 是真实并发上限，不是父进程数量。
- 新一轮实验证据应记录命令、模式、固定输入、UTC/session、测试计数、失败分类、实际峰值与真实收尾；失败停止定位。成功路径同步诊断会扰动竞态；新增采样优先内存聚合，结束后落盘。

## 下一次选择实验时

从全链数据重新选点：真实 E2E 与组件边界、重复 Git/slot 准备、增量命中/失效、进程隔离/启动、跨包构建与 coverage。已构建一次与原有查询合并无需重复实现。每个候选先给同口径收益上限和最小可证伪实验；完整 gate、增量和局部成绩分开报告。只有代码稳定后的原完整检查才能声称该候选全量通过。

### `96cd5c8…` 上的后续小实验：真实 Git 夹具批量准备

**原型阶段（01:16 UTC）的结论：有局部收益，当时尚未接入项目测试。** 后续接入见下一节；不把下列原型数据加到 1302.75 秒上宣称全量收益。

先只读全量记录发现：release 文件执行区间合计 1571.534 秒，双 worker 工作量下界约 785.767 秒，相对实际 794.012 秒仅余 8.245 秒。其他 26 包任务累计 281.069 秒，双 worker 下界 140.534 秒，实际任务跨度 141.225 秒。当前排序已接近满载；跨包启动/加载/报告等在测试文件区间外合计 106.929 秒，包含多种工作，不能全部称为纯 spawn 成本。

通用 `managedFixture` 在 22 个测试文件中被引用，关联 164 个用例（静态范围，不是动态调用数）。它每次从空目录建 bare remote、工作树及两个提交；准备本身不承担被测发布 push 的失败机制。使用真实 Git `fast-import` 生成同样的提交图、索引与 refs，是夹具准备算法优化，不改受管执行器或门禁。

| 5 次顺序采样 | 准备中位秒数 | 直接 Git 调用 | 判断 |
|---|---:|---:|---|
| 原夹具 | 1.780149 | 12 | 原代码仅转译并将 import/base 重定位；原函数逻辑未改 |
| 普通 fast-import 原型 | 1.348650 | 5 | 只有约 24% 收益，不能按进程数推算收益 |
| 每条 fast-import 加 `-c fastimport.unpackLimit=0` | 0.375860 | 5 | 约 79% 局部收益；只改变本次创建对象的 pack 存储，不改宿主 Git 配置 |

定向 Trace2 找到普通原型内部两次 `unpack-objects` 各约 0.5 秒。Git 自带 `git-config` 文档说明该阈值控制小 pack 解包；保留 pack 后仍以真实 Git `fsck --strict`、两提交树/父关系、干净索引、dev/main 及 origin refs、后续真实 commit/push、独立夹具变更进行对照，5 个原型都通过。目录继续独立创建，未复制历史 slot、文件身份、锁或成功凭证。

四次诊断 UTC/session：baseline `01:06:58.872–01:07:08.928 / 3167`；初版 `01:12:02.813–01:12:21.772 / 58584`；Trace2 `01:14:29.945–01:14:32.447 / 3752`；pack 版 `01:15:48.499–01:16:01.962 / 30576`（均 2026-10-27）。原 context/consumer observer、隐藏窗口、每次真实峰值 1、exit 0、正常关闭且为空，fixture 均在 finally 清理。原 helper SHA256 为 `1b9cd6d9e9c180c5fc6c2abf4316681d5d22114a6451af43fe6558f9c97918d9`；完整诊断命令、数据及代码保存在 `.tmp/test-performance-skill-20261027/`，不作为未来测试前提。

若假设 164 个相关用例各准备一次、收益均匀分到两个 worker，测得节省约 115 秒；让整个准备归零的同模型上限约 146 秒。实际调用数、coverage 环境、调度与 downstream Git 对 pack 的访问会改变收益，不能作全量保证，更不能承诺 5 分钟。下一步先把最小 helper 与自包含等价测试纳入仓库，检查原夹具的 Git 属性/过滤器、提交及 remote 语义，保留所有现有真实集成用例，再做定向回归与组合后的完整验收。普通 fast-import 的低收益原因已定位，无新证据不重复该版本；不得把所有集成测试换成合成发布状态。

### 正式测试夹具接入与局部测量

`96cd5c8c1b2124de96c112c4b8447ef12210f515` 上的后续未提交改动已接入 [managed-fixture-git.ts](../../../../packages/release-vercel/tests/helpers/managed-fixture-git.ts)，现有调用方继续通过 `managedFixture()` 创建独立资源。准备使用两个真实 init、两个 fast-import、一个 read-tree；后续 `commit()` 和所有被测 Git 命令保持原路径。仅准备固定 LF 普通文件，不验证准备阶段的 clean filter/hook；原有专门场景仍在创建夹具后建立，消费者继续覆盖 CRLF。

- 成本回归先在原实现观测到 `12 > 5`；另一个红测试证实原初始化失败会遗留目录。新增 [6 项回归](../../../../packages/release-vercel/tests/managed-fixture.test.ts) 检查两提交的字节/身份/父关系、真实索引、refs、独立 clone 和后续 commit/push；首条 Git、远端导入、read-tree 及清理双失败均有覆盖，保留另一存活夹具验证隔离。最终局部运行 session `14227`，UTC `01:51:11.097–01:51:20.719`，exit 0，真实峰值 1，受管任务正常关闭且为空。
- 交替顺序的原实现/正式候选各 5 个新夹具：中位 **1.9262312 → 0.4144261 秒**，少 **1.5118051 秒 / 78.5%**；直接 Git 调用 **12 → 5**。session `52930`，UTC `01:47:19.414–01:47:37.310`；原 context/observer、真实峰值 1、正常关闭且为空，输入前后不变，全部新夹具已清理。测量只做 TypeScript 转译和 import/base 重定位，不是完整门禁。
- 测量的原 helper SHA256 `1b9cd6d9e9c180c5fc6c2abf4316681d5d22114a6451af43fe6558f9c97918d9`，正式夹具 `9c554fe6d334d9d3f16d478cebbb5a7904fd05b6d64b11140a6e9d239ea6a1cd`，新 Git helper `23f777859afb470ad1653a6762541eeeb6e5a5b3c7c7f9c0cec1c9b80cd147fe`。
- 35 项夹具/来源冻结/checkout 回归通过，session `36116`，UTC `01:48:33.343–01:49:20.226`，外部 46.883575 秒，真实峰值 2。来源文件 29 项用例耗时 43.916 秒（上次全量 83.983 秒）；checkout 两项 35.733 秒（上次 33.897 秒）。口径含调度环境差异，不能把全部文件差额归因于夹具。
- 原完整受管 `check` 代表用例通过，session `62761`，UTC `01:49:38.384–01:50:42.933`，外部 64.5497509 秒，真实峰值 1，正常关闭且为空；保留原生产入口、observer 与安全门禁。
- 独立只读复审未发现阻塞缺陷，建议的导入/索引失败隔离回归已补入。首次 clone 测试误把工作树 CRLF 当成失败；修正为精确核对提交 LF 字节、checkout 内容及干净索引，未改宿主 Git 配置。不要通过强制所有测试 LF 来掩盖跨平台语义。

该阶段的完整命令、输入映射与失败证据保存在 `.tmp/git-fixture-integration-20261027/`；它们不是项目测试依赖。此前 115 秒仍是静态假设粗估，最终全量墙钟需单独报告；局部收益不代表达到五分钟。

### 接入后的第一次完整门禁：脚本阶段失败

**状态：候选有实测局部收益及定向等价证据，但尚未完成全量验收，未提交推送。** 不能用中断时长与 1302.75 秒比较，不能宣称完整检查达到五分钟。

- 同一 `96cd5c8…` 基线，原命令 `pnpm --config.store-dir=E:\source\ai\.pnpm-store run check`，显式两个 worker、隐藏窗口。session `50832`，UTC `2026-10-27T01:55:41.0315241Z` → `02:02:42.6762107Z`，**421.6446866 秒、exit 1**；确认进入 Full check。期间 1016 个输入未变，映射 SHA256 `d7ae8d81957b435c4d390a9d46a5ecdb105ab17362cafe548fc8137f99e9d059`，全部 dist 与上次通过的收据一致。本小节在运行结束后补写，只记录事实，不代表已重验该文档字节。
- 已完成 lint 17.50 秒、pack 359.53 秒、typecheck 16.72 秒、cycles 1.31 秒；脚本阶段执行 24.48 秒后停止。12 个脚本文件共 63 通过、1 失败；其余脚本和所有包 coverage 未启动。
- pack 子阶段：metadata 0.94 秒、一次 build 17.98 秒、真实 tarball/浏览器边界 10.32 秒、consumer install 104.72 秒、imports 21.59 秒、smokes 214.34 秒；release smoke 200.8380915 秒且通过。安装及 smoke 本次高于旧 53.44 / 167.03 秒，不应把环境波动算作夹具因果收益或倒退。
- 36 个已启动受管任务均 `closed / normal / empty=true`，其中脚本失败任务 exit 1，其余 exit 0；25 个预算预约全部结束，真实峰值 2、active 0、remaining 空。测试清理了失败子进程，不能因此声称原 MCP probe 正常收尾。夹具父目录前后仍为同样 7 个历史目录，未删除历史资源。
- 失败位于未改动的 [ab-eval-tool-contract.test.mjs](../../../../scripts/tests/ab-eval-tool-contract.test.mjs) 的 `MCP tool probe closes the real child after a request deadline`，断言为 `deadline returned before its child closed`。日志显示 taskkill 在用例相对 120.94–180.49 ms 执行、status 1；probe 约 5192.12 ms 返回时 child 尚未关闭，fixture 随后仅强制清理自己创建的一层 Node，约 5199.22 ms 才有真实 close。
- [tool-contract.mjs](../../../../scripts/ab-eval/tool-contract.mjs) 的 `stopOwned` 忽略 taskkill 返回状态，`stopped` 仍置真；5 秒关闭等待失败后，以 cause 保留关闭异常并抛出主请求超时。以上可由原代码/日志核实，但 **taskkill 本次为何 status 1 未知**，因为原调用丢弃 stderr。脚本、依赖及 dist 未改，且本轮通用夹具尚未进入 coverage；没有证据证明此失败由候选导致，也不能据此证明候选全量无回归。

停止条件已执行：不重跑整包/全量，不提高超时或并发，不添加 taskkill 重试、替代终止或安全配置变更。后续若继续定位，应先在原 context/observer 下对本任务子进程的终止失败收集最小错误证据，再决定修复；不能把一次隔离通过当根因修复。该取消链路不是本轮 fast-import 优化点，不混入未经验证的修复。

完整证据：`.tmp/git-fixture-integration-20261027/failed-full-audit.json`、`final-check.status.json`、`failed-full-fingerprint.json`，context `.tmp/check-runs/run-mo8gUw/`，失败日志 `jobs/35/stdout.log`。原审批/访问边界继续有效。

### 原 MCP 超时关闭单例：本次访问拒绝已证实

父任务随后明确授权只诊断原 `MCP tool probe closes the real child after a request deadline`。没有再次运行全量，也未改脚本源或 Git 夹具候选。诊断在原 `createTestRunContext`、Node test observer 和 Job 中执行，仅筛选该用例；预算仍为 2、实际峰值 1。原 50ms 请求超时、5000ms 关闭等待、15000ms 测试时限及隐藏窗口全部保留。

- session `16219`，UTC `2026-10-27T02:14:41.5124230Z` → `02:14:47.9206932Z`，外部 **6.4082702 秒、exit 1**。context `run-aOICmx`；一个受管任务 `closed / normal / empty=true`，active 0、remaining 空，输入前后未变。
- 只对当前测试进程亲自 spawn 的 fixture PID 观察原 taskkill 调用，参数和终止机制不变；只把原本丢弃的 stdout/stderr 暂存内存，保存状态与脱敏分类，不保存原文、原始字节或秘密参数。唯一尝试 **status 1、signal null、error null、类别 ACCESS_DENIED**，stderr 17 字节。没有 Node spawn 异常，因此 code/syscall 不存在；没有捏造错误码。
- 原关闭断言失败后，测试既有的单层 fixture 异常清理产生真实 SIGKILL/close；本轮未添加 fallback、重试、替换终止、权限或系统配置修改。证实访问拒绝后立即停止相关执行。
- 审批上下文存在可核实差别：`b6c8224…` 的 `final47-production-delivery.md` 明确记录 `require_escalated` 审批后运行；本轮全量 `50832` 与单例 `16219` 均为 `use_default` 受限上下文。`96cd5c8…` 的成功状态记录能核对同一 Node/pnpm 路径、命令、隐藏及双 worker 设置，但未保存审批模式，不能据此断言上下文相同。
- 历史 `.tmp/test-budget-integration-20261026/taskkill-message-diagnostic/stdout.log` 也记录 status 1/访问拒绝，而 `taskkill-approved-context-once/stdout.log` 记录 status 0。历史成功不是当前授权，本次结论依赖新单例，而非推定。先前全量 `50832` 丢弃了 taskkill stderr，因此本次重现与其症状一致，但不能倒填那一次未记录的原始错误。

当时阻塞是**真实运行时访问拒绝**，不是本轮工具自动审批拒绝，也不是已证实需要修改测试逻辑的缺陷。下一步应由父任务通过受支持的审批机制确认与成功生产验收一致的单例执行上下文；未获新的相关授权前不重试被拒绝操作，更不能先重跑全量。即使后续单例通过，也不能当作 fast-import 候选的完整验收。

新证据位于 `.tmp/mcp-close-diagnostic-20261027/`：`started.json`（固定输入/精确命令）、`termination-observation.json`（仅安全元数据）、`outcome.json`、`single.status.json` 与原 Job 日志。Git 夹具候选仍保留未提交，全量 coverage 仍未覆盖。

### 同一单例的最小批准上下文复验

父任务随后提供用户对同一自建 fixture 终止操作的明确授权，允许提出一次最小执行权限申请。通过 `exec_command` 的 `require_escalated` 机制为同一单例提交申请，**工具实际批准并执行**，不是把用户同意当成工具已放行。没有申请全局进程访问或修改系统权限，也没有恢复全量。

- session `81435`，UTC `2026-10-27T02:22:45.5723313Z` → `02:22:47.5744485Z`，外部 **2.0021172 秒、exit 0**；原单例 1 项通过。context `run-pAiZGS`，一个 Job `closed / normal / empty=true`，实际 worker 峰值 1、active 0、remaining 空，输入前后未变。
- 唯一 taskkill 尝试 **status 0、signal null、error null**，stderr 0 字节，拒绝类别为空。原测试的 child close 先于 probe 返回，fixture 强制清理事件为 0；这次确实由原 taskkill 路径完成终止。
- 原 50ms/5000ms/15000ms 超时、隐藏、预算 2、原 context/observer 和终止参数保持。诊断观测文件 SHA256 `d373369223219740a135c510d11fddc0682be9a33003b235030a94d4774c3fbb` 与前次受限诊断相同；隐藏启动器也逐字相同。runner 只改执行上下文描述，独立目录避免覆盖旧失败证据。
- 默认受限单例的访问拒绝与批准上下文的成功共同支持“先确认这项 OS 能力的执行上下文”的前置要求；不宣称所有任务需要提升权限，也不把两次成功/失败的耗时差当成性能优化收益。未经授权或工具拒绝时停止，不能复制旧批准覆盖新范围。

证据在 `.tmp/mcp-close-approved-20261027/`：`preparation.json`、`started.json`、`termination-observation.json`、`outcome.json`、`approval-and-close-proof.json`、`single.status.json` 与原 Job 日志。单例能力已在批准上下文通过，**fast-import 候选的完整验收仍未通过，未提交推送，五分钟目标仍未达成**；后续全量须按当前授权范围与适用审批单独处理。

### 第二次完整门禁：批准上下文启动，因用户报告闪窗而停止

父任务随后授权恢复一次原完整 `pnpm check`，该完整命令独立通过 `require_escalated` 工具审批。基线仍为 `96cd5c8…`，冻结 1016 个输入，映射 SHA256 `f3ad7d45c0c660ea04bb9f5f6e9267b47f2d6357b0db7b98e404f78b2baec9be`。session `22514` 于 **2026-10-27T02:28:57.4795056Z** 启动；02:52:56 UTC 静态复核冻结输入全部未变。本节和技能方法在该复核之后补写，未重新运行门禁。

- 用户在 **02:30:39.663 UTC** 报告闪窗，随后父任务确认截图标题为 `C:\WINDOWS\system32\cmd.exe`；图片不带可核实的父进程身份，不能判定具体窗口归属。当时唯一未结束的受管测试 Job 是 release 消费者，区间为 `02:29:50.074–02:32:37.330`、167.2566868 秒；本轮新 fast-import 测试 helper 尚未进入 coverage 执行。
- 外层 Node/pnpm PID `130288` 经 PID、进程名和创建时间核对后取消，**02:34:26.2628039Z** 退出；但原链已在 `02:34:25.823Z` 开始 coverage，并在外层退出后继续启动 worker。外层取消不足以证明整体停止，这是本轮实际暴露的取消缺口；未另起任何独立测试运行。
- 已知 worker PID 的单目标 CIM 读取在受限上下文被拒绝，未重试、未全局枚举。随后经支持的审批，仅核本任务记录和创建时间并停止仍存活的 worker `125488`、`53388`；其余已记录 worker 已退出。一次时间比较保护拒绝执行后，修正为明确 UTC 的 DateTimeOffset 比较，未移除身份保护。
- coverage Job `dc005075-172a-49c0-af1c-791aa1406bdb` 于 **02:39:04.131Z** 完成收尾，exit 1。context `run-o5swaX` 的 **69 个受管 Job 均 closed / normal / empty=true**，实际峰值 2、active 0、remaining 空。这里的 closure 表示容器收尾完成，不表示被中止的测试自然成功。外层状态记录的 328.783 秒只到外层退出；从启动到最后 Job 清空共 606.651 秒，均不可当性能成绩。
- 已完成阶段为 lint 12.68、pack 209.69、typecheck 13.67、cycles 0.49、脚本 90.63 秒；release coverage 仅执行了被中止的 278.33 秒。两个被中止 fixture 目录保留作证据，未删除历史资源。没有完整 coverage 结果，候选仍未全量通过、未提交推送、未达到五分钟。

**静态发现，不等于截图归因或修复验证：** 本机 pnpm 10.33.2 的实际 bundle（SHA256 `a04379c877cf74b4cbc585ab3a14fd52eea2d52b5aa0fb854cbd4485cd73b347`）在 lifecycle `runCmd_` 为 Windows 选择 `cmd /d /s /c`，构造的 spawn 选项只有 cwd/env/stdio 和 windowsVerbatimArguments，没有 windowsHide；底层 wrapper 原样调用 Node spawn。根 `check → check:full`、build/typecheck 脚本及 release 消费者 beta 的真实 postinstall 都可到达该路径。直接 Node 调用 pnpm CLI 只消除入口 `.cmd` 包装，未消除内部 shell；尚未读取用户全局配置，不能排除环境另有 shell 配置。

本机 Node 文件版本为 24.11.1；该版本的 [libuv Windows 启动实现](https://github.com/nodejs/node/blob/v24.11.1/deps/uv/src/win/process.c#L970) 按每次调用的 hide/stdio/detached 选项设置创建标志。Windows 的 [CREATE_NO_WINDOW 文档](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags) 说明该标志与 DETACHED_PROCESS 同时使用时会被忽略。仓库 supervisor/scope-host 使用 detached 保持原 Job 语义，不能只靠 windowsHide 字段声称后代无窗口，也不能未经等价证明删除 detached。

另有次级静态缺口：部分 consumer Git 调用和 release 内联 Git payload 未设置 windowsHide；repository-context 的 Windows `.cmd` bin 消费者刻意走 shell，但自身已有 windowsHide。新 fast-import helper 自身仅启动隐藏 Git；不能由此证明 Git 内部全部无窗口，也不能把它归为首次报告的原因。精确源码位置和外部实现引用保存在下述交接文件，不把关键词搜索当完整性证明。

停止后的授权边界为**静态排查，不启动真实复现、定向测试或全量，直到父任务确认可安全做最小无窗口验证**。下一步先设计在 OS 创建前截断的 spawn 参数检查，再确定真实自建 fixture 的受管停止与可见性证据；这些检查本轮尚未执行。不得修改系统安全、用户控制台、共享 pnpm 安装或以 shell 替换绕过原语义。

证据：`.tmp/git-fixture-approved-check-20261027/user-stop-audit.json`、`user-stop.json`、`owned-worker-stop-final.json`、`stop-and-window-handoff.md` 及原 context 日志。两次完整尝试分别为脚本失败和用户中止，不能合并成一次成功验收。

### 闪窗后续：纯注入检查与直接调用的小修

父任务随后明确授权最小设计、不可透传的依赖注入检查，以及补齐项目自有遗漏；仍禁止启动真实 OS fixture、测试复现和全量。检查在已有 functions V8 隔离运行时完成，本机工具只读写源码和证据，没有另起 Node 测试进程。

- **已实施，但尚未真实运行验证**：10 个现有验收文件共 20 处增加 `windowsHide:true`，涉及 release 的 CLI/managed-release/source-managed 测试，以及 repository-files、source-snapshot、text-integrity、workspace-checks-pnpm、repository-policy 的消费者。26 个实际调用表达式先注入观察到 20 处缺失，改动回读后全部为 true，其他 command/args/options 完全一致。未删断言、改原 timeout、真实 Git 行为或覆盖率；这些只是启动参数契约，不是可见性证明。
- **取消设计片段，未落入生产源码**：原 `runFullCheck` 注入取消后仍调用 typecheck、cycles、scripts、coverage；阶段前检查的内存原型阻止这四个后续阶段。原 `runTestProcess` 对已取消 signal 仍创建一次 scope；前置检查原型的创建数为 0。context 活动 Job 的取消传播、外层根 Job 及真实排空尚未验证，不可声称整链取消已修复。
- **仅局部可行，不足以交付的 pnpm shim**：实际固定版本 lifecycle 片段经注入证实原 cmd 调用未隐藏；只增加 windowsHide 的内存 wrapper 保持 argv、环境对象、原返回对象与异常对象。它没有接入项目或修改共享 pnpm。原生孙进程不经过 Node wrapper，且 `process-control-node/src/owned-scope/protocol.ts` 明确剔除 NODE_OPTIONS；以环境 preload 传播隐藏的方案会在此失效。不得删除这项隔离、改 shell 解释或跨版本默默应用。
- **目前尚缺**：覆盖间接原生后代的隐藏保证，以及带取消通道的整套根 Job。进程级显示标志和 Job UI 限制不能单凭名字满足该保证。专有非交互窗口站/desktop 只列为待核的入口候选；没有创建对象、切换桌面、更改系统配置或申请额外权限。

纯检查早期有替身绑定遗漏（target、stage、PATH），已定位为检查搭建错误并补齐；未将这些 ReferenceError 当成产品缺陷，未启动任何真实进程来排错。证据与文件行号在 `.tmp/window-repair-design-20261027/pure-evidence.json`，最小文件范围、后续单 Node 隐藏入口建议及停止条件在同目录 `design.md`。这些诊断文件不构成标准测试的输入依赖。

当前仍未提交推送。Git 夹具性能候选和本轮隐藏小修都没有完整验收通过；完整测试的五分钟目标仍未达成。恢复任何真实执行继续遵循最新父任务确认与适用工具审批，不把本次纯检查授权扩大为进程复现授权。
### 最小补丁阶段：固定 pnpm 入口与协作取消（尚未真实验收）

基线仍为 dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515。原 session 22514 的 69 个 Job 于 02:39:04.131Z 清空后，本阶段没有另启 Node 测试、pnpm、Git fixture 或全量。文件读写和现有 V8 隔离运行时中的纯注入不代表 OS 验证。

已实施：四个现有协调/执行脚本接入 AbortSignal；context 先锁住预算，再取消活动 Job，等待进程与直接预算租约的尾部结束。新增仅供 check 的共享文件门闩，保留 pnpm lifecycle；未新增根 Job。固定版本 pnpm 入口只在自己的进程中适配 spawn / spawnSync，通过 npm_execpath 与局部 PATH shim 传播，不依赖 NODE_OPTIONS，不改共享安装或原生 Provider。

回读实际源码后，新增取消回归 9 项和 pnpm/文件门闩回归 7 项纯注入通过；26 个项目调用表达式全部带 hide。旧完整检查的 4 组调度/失败回归及 2 组错误保留回归也经纯注入通过。信号和 OS/文件依赖使用替身，未冒充 Node 原生集成测试。额外发现并按先失败后修复处理了两点：只等 Job 会遗漏直接预算租约的尾部；省略 args 的 spawn 第三参数不能被 shim 丢失。一次事件观察器替身按函数而非事件名建索引导致检查失败，修正的是检查替身，未当作产品失败。

质量边界不变：两个实际 worker 上限、原 timeout/coverage/测试断言、真实 Git/tarball/进程回归、隐藏/取消和收尾失败不能假成功。构建前的普通进程仍等待自然关闭，原生孙进程可见性尚未证明；普通外部 pnpm 不会自动取得显式适配。完整验证与性能目标都仍未完成，不能宣称五分钟或无闪窗达标。

启动边界、可重复回归、首次探测风险和恢复门槛见 [Windows 验收边界](windows-check-boundaries.md)。本阶段证据位于 .tmp/window-repair-implementation-20261027；临时证据不是正式测试的依赖。补丁、Git 夹具候选和 skill 均未提交推送，等待父任务审核及最小真实验证安排。
### 单次最小 Windows 实测：功能取消成立，窗口可见性仍未知

2026-10-27 基线 dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515。用户明确允许 1 worker、5 秒工作预算及原有收尾的单次探针；具体命令独立通过 require_escalated 审批。临时入口位于 .tmp/window-minimal-probe-20261027，未借用全量入口、修改生产源码或全局设置。

实际命令是专用隐藏宿主启动 Node probe.mjs，随后仅一个正式 context / observer / Job 执行显式 pnpm.cjs 入口。fixture 的 probe 脚本调用 pnpm run nested，nested 调用等待取消的 Node payload；中文空格工作目录保留。其他完整检查阶段均为注入边界，没有实际运行 lint、安装、coverage 或全量。排队后的检测回调只写内存，即使门闩错误也不会另起进程。

宿主超时／收尾 6 项及实际 owner 身份保护 3 项纯注入先通过。宿主在 5 秒写取消门闩，保留 10 秒收尾预算；末端兜底只停止它直接 Start 并核对 PID／创建时间的专用 Job-owner Node，依赖已有 KILL_ON_JOB_CLOSE，不枚举或 Kill 整棵进程树。兜底不能产生成功或 Job 空的结论。本次未触发工作超时、owner 强制停止或任何重试。

真实 session 57622：04:55:06.9396499Z 开始，04:55:08.3649705Z 结束，宿主墙钟 1.4230153 秒，exit 0，stdout/stderr 排空。嵌套 payload 报告 npm_execpath 为项目显式适配入口；04:55:08.293Z 写取消标记，driver 于 04:55:08.324Z 观察到，延迟 31 ms。配置的 50 ms 轮询不是响应延迟上限。

context run-7EfJkx 只启动／完成 1 个任务，实际峰值 1，active 0、remaining 空，排队回调及后续阶段均未执行。Job b6a5d01a-afef-49e5-976c-cc514f46dba8 于 04:55:08.335Z 记录 status=unknown、reason=terminated、empty=true；这是有意取消，不是自然成功的 closed/normal。预算在 04:55:08.343Z 归零。

没有可用的窗口观察器，没有全局枚举或操作未知窗口。因此结论仅为这条真实 lifecycle／嵌套 pnpm／文件取消／Job 收尾链的功能成立，不能证明无闪窗，不能外推完整 gate 或 Git 原生后代。该 1.423 秒不是测试性能成绩，也不表示五分钟目标达成。

可复核证据：同目录 launch-status.json、probe-result.json、workers.jsonl、pure-host-contract.json、inputs.json，以及 context 的 jobs/0/process.json、budget.jsonl、summary.json。执行前冻结 2356 个源码、构建及入口输入，inputs.json 的 SHA256 为 6cef96f34efe95b79e9f76d30d45040838420b867497e3ae3747f1b0a10d742d；launcher SHA256 为 9484cfbb1113ba425cbba870beb86e1cc495e239e68cb06f17079629edf11d20。run.claim 保留以防重复启动。未运行第二次、全量或提交推送。

### 晚到取消和 pnpm 入口绑定：纯注入修复，真实执行继续暂停

2026-10-27，基线仍为 dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515。独立静态复核确认两类 P2：finalize、persist、dispose 和输出读取的最后 await 期间取消可能被记为成功；只校验 pnpm 父目录 manifest 与 bundle 会误接收同目录 pnpx 入口。windowsHide: null 的早期疑点经 Node 24.11.1 源码核对撤回，不属于缺陷。

先在现有 V8 隔离运行时中复现 6 项新增失败和 2 项收据失败，再修改源码。成功收据使用 UUID 独占暂存与同步最终发布，异步准备期间取消只删除自有暂存，保留旧收据及另一运行已提交结果；私有 Symbol 将已提交结果传递到 CLI，避免提交后取消又改判失败。Job 保持原 termination/dispose/completion 顺序，在同步终态写入前记录晚到取消；context 输出读取前后检查全局和独立 spec signal。没有放宽 Job/lease 收尾或资源限制。

pnpm 同时绑定 manifest.bin.pnpm、bin 入口字节和 dist bundle 字节；入口 SHA256 为 b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9。复审发现路径校验混用宿主语义，用 POSIX 路径替身复现 2 项失败后统一为 win32 路径处理；不以只在 Windows 上运行测试来隐藏问题。

回读后，取消/收据 17 项全部通过（含异步写入与关闭两种取消时点），pnpm 11 项在 Windows 与 POSIX 两套路径替身下均通过；另有 4 组既有完整调度/失败、2 组错误保留和 3 组脚本收据回归通过。这些是实际源码在不可透传的文件/信号/进程替身中的检查，不是 Node 测试运行。实现与证据见 .tmp/window-p2-fix-20261027；正式回归仍由仓库源码自包含，不依赖该临时目录。

本轮没有新启动 Node、pnpm、Git、真实测试或探针，没有提交推送。用户对 04:55 UTC 单次探针反馈「没注意」，无闪窗仍未验证，不再以等待观察反馈代替这一结论。更新后的代码尚无真实 Windows/Node、lint 或完整 pnpm check 验收；该历史探针不能作为新代码的实测。五分钟性能目标仍未达到。

### 第二次最小探针与限权原生 A/B：短链通过，全仓 lint 阻塞

用户在收到开始提醒后，于 2026-10-27 对第二次探针反馈「没有看到窗口闪现」。session 42248 经独立 require_escalated 审批，于 05:50:30.4236040Z–05:50:32.2098582Z 执行，宿主 1.7842378 秒，exit 0、日志排空。取消观察延迟 47 ms；Job 3be1c6bf-cf1d-4f51-a544-23a5dce64189 于 05:50:32.164Z 确认 terminated/empty，05:50:32.174Z 租约归零，峰值 1、remaining 空，排队和后续阶段未启动。未触发超时或强制停止。证据在 .tmp/window-minimal-probe-p2-20261027；其输入指纹为 9e188d1078a23124985a4ff3f10101172805ea110d73773838f8f745976eef29。用户观察只支持该探针链路，不能推广为全部 pnpm、Git 或原生后代无闪窗。

随后获准只执行预修及 A/B；没有执行 Git 定向 C 或完整 D。宿主仅启动一个隐藏 Node，Node 权限限制为仓库读、.tmp 写，并禁止 child_process、Worker 和 addon。A 总宿主上限 30 秒，lint/tsc 各 60 秒，均在该上限内预留 10 秒收尾；六项纯宿主时限检查先通过。

定向 lint 06:08:35.7149220Z–06:08:36.9906290Z，exit 1，恰好确认新增回归两处裸 queueMicrotask 的 no-undef。只补两处 globalThis 前缀，没有修改 lint 配置。A 于 06:10:21.7369677Z–06:10:21.9352922Z 正常退出，原生 Node 报告 40 pass、0 fail/cancelled/skipped/todo；宿主 0.1997981 秒，Node 报告测试耗时 105.5622 ms。测试的进程依赖仍为替身，这不是原生 Job 或全量验收。

全仓 lint 于 06:11:19.2061312Z–06:11:33.7402085Z 正常退出，exit 1，4 errors、0 warnings：check-cancellation.mjs 与 hidden-pnpm/runtime.mjs 的 no-dynamic-delete；check-runner.mjs 与 test-run-context.mjs 的 preserve-caught-error。这是代码规则失败，未遇权限拒绝。按首个意外失败停止，tsc 为 NOT RUN，未重跑或顺带修改这四处。

三次已执行命令均实际退出、日志排空，没有超时或强制停止。完整命令、UTC、输出和收尾状态见 .tmp/window-native-ab-20261027/outcome.json；A/B 冻结 2361 个输入，清单 SHA256 为 eb709796430ef5df854da9cc804569cf10ab72478dc4450d5c5e28700abd0462，结束复核无漂移。本记录和 Windows 边界文档在该核对之后追加，不冒充已测试输入。下一步应先最小修复上述 lint 规则冲突并保留原始错误/环境恢复语义，再继续尚未执行的类型检查；不借此自动恢复 C/D 或扩大权限。未提交推送，五分钟完整验收目标仍未证明。

### 四处 lint 语义等价修复与 A/B 复验通过

2026-10-27，dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515。上一轮 4 个 lint 错误先有真实失败证据；本轮未放宽规则。两处动态 delete 改为 Reflect.deleteProperty，并在 false 时仍抛 TypeError，Proxy 原异常原样传播。两处 AggregateError 构造移出内层 catch，保持原失败为 cause、原有错误顺序，并保留 undefined/null/false/0 等任意收尾异常。取消检查、收据提交点及 Job/lease 释放顺序未改。

新增 4 个持久边界回归，生产修复前后纯注入均通过：这是语义等价核对，不是新的行为缺陷复现。取消/收据现有 19 项，pnpm 13 项在 Windows/POSIX 两套路径替身下均通过；独立静态复审未发现缺陷。真实 A 于 06:29:35.8769155Z–06:29:36.1225205Z 执行，44 pass、0 fail/cancelled/skipped/todo，宿主 0.2472405 秒；单 Node 内的进程依赖仍是替身。

全仓 lint 于 06:29:54.9774762Z–06:30:11.0973913Z 通过，0 errors、0 warnings，16.1218833 秒；release-vercel tsc --noEmit 于 06:30:38.1057779Z–06:30:41.6130001Z 通过，3.5107201 秒。三条具体命令分别经过 require_escalated 审批，仍为单隐藏 Node、仓库读/.tmp 写，禁止 child_process、Worker、addon；A 总宿主上限 30 秒，lint/tsc 60 秒，均内含 10 秒收尾预留。三次 exit 0、根进程自然退出、日志排空，无超时或强制停止。

证据在 .tmp/window-native-ab-lintfix-20261027/outcome.json、各 stage 的 inputs/status/stdout/stderr，以及 pure-equivalence.json；session 分别为 6642、48501、76487。2361 输入的清单 SHA256 为 01b250fb51fb410b54d5c2e732052b9344e2edf9ffde61de99fa5a90323f9c1f，执行后无漂移；本条和 Windows 边界说明在审计后补充。旧失败、claim 和日志保留，没有以覆盖旧证据的方式重试。

C（Git 真实定向/性能）及 D（完整 pnpm check）均未运行，现有候选仍未完整验收，五分钟目标未证明；A/B 也不是新增的真实 Job 或窗口可见性验证。本轮未提交、推送或触发 CI，后续须遵循当前具体授权。

### C/D 已完成：质量通过，全量性能回退

2026-10-27，基线 dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515。用户批准 C 通过且清空后运行一次 D；两条具体命令分别经 require_escalated 审批，未重跑、提交、推送、发布或 dispatch CI。执行入口、2359 个源码/产物/运行时输入清单及八项纯宿主时限检查保存在 .tmp/window-cd-20261027；输入清单 SHA256 为 2c61c9ec392113bf85d60682ff69a90d3707a8221e790ae92c6780078d2035de。正式脚本和测试不引用本临时目录。

C session 77250 于 06:45:15.6235032Z–06:47:10.0334938Z 执行，114.4070879 秒，3 文件/37 项通过，0 跳过。入口由代理显式选取既有 managed-fixture、source-managed、managed-checkout-reuse 三文件代表组，不是脚本默认附加；这偏离了原单文件6项计划，多执行31项，后续应按已批准的准确文件集合冻结，不能自行以「同类」扩大计划。仍保持1 worker、150秒工作加10秒收尾，未修改原测试超时。Job 于06:47:09.946Z正常清空，租约归零、remaining为空，无预算触发或强停。

D session 23567 于 06:48:09.9694869Z–07:16:03.1474352Z 执行正式 pnpm check，exit 0，1673.1794048 秒。固定 pnpm 隐藏入口保留生命周期；临时宿主直接复用现有 runTestProcess/Provider 包住本次完整命令，不占用额外测试 worker，也不构成新的生产框架。其已冻结 dist 仅用于本次安全宿主；正式完整入口仍执行原构建。宿主采用有界轮询，未套用C的工作预算或扩大原产品/测试超时；取消收尾仍10秒。本次没有取消、超时或强停。

质量证据：47脚本文件/349项通过，0失败/取消/跳过；27包/189文件/1408项通过，仅原有3项平台跳过。正式context的98份进程报告及外层Job均closed/normal/empty；52次预算任务全部完成，实际峰值2、active=0、remaining为空。外层Job于07:16:03.098Z清空，宿主自然退出且日志排空。39个release生产源码覆盖文件的既有覆盖点无损失：2168 statements、307 functions、1846 branches。源码、入口与重建产物哈希无漂移；独立只读review逐份确认退场。详见d/audit.json、d/result.json、d/launch-status.json及context run-RC1ITU。

| 阶段 | 1302.75秒基线 | 本次 |
|---|---:|---:|
| lint | 16.20 | 17.72 |
| 包验证 | 251.69 | 297.74 |
| 类型检查 | 12.46 | 14.36 |
| 循环依赖 | 0.76 | 0.53 |
| 脚本测试 | 83.76 | 124.37 |
| 全包coverage | 936.25 | 1215.53 |
| 宿主总墙钟 | 1302.7499428 | 1673.1794048 |

本次整体慢370.429462秒（28.43%），未证明完整验收提速，五分钟目标未达成。release包794.01→1011.87秒；managed-release文件322.08→509.17秒是最大单文件增量。消费者smoke176.14→243.83秒；这些阶段存在重叠，不能直接累加成总收益。此前fast-import局部配对收益仍是局部证据，粗估115秒不能当成全量收益；当前包含隐藏/取消修复及外层安全宿主，不能用这一次跨批比较断言某一改动导致变慢。没有追加实验或猜测性生产修复，候选保持未提交，等待本次证据审阅。

本轮没有窗口观察器；未收到闪窗反馈不等同于全部路径不可见的证明。第二次短探针的用户观察只适用于原短链。以上持久记录在正式输入审计后追加；不得把文档更新后的整棵树说成原清单完全一致，也不伪造新的检查收据。

### 测试内容候选：checkout 前置准备，基线在磁盘预算准入失败

2026-10-27，dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515。用户要求优先减少测试内容中的重复工作，并明确整体不能慢于 1302.75 秒；此前停止所有新进程的限制由新的测试授权解除。重新核对 2359 个旧输入，仅两份已记录的 skill 参考文档发生预期变化，没有发现其他源码或产物漂移。

候选仅针对 managed-release 中「准备命令修改已提交源码」和「pnpm 版本不匹配」两条失败机制。已有全量单例耗时为 70.85 秒、49.36 秒；拟用既有 commandComponentSession 执行前置真实 checkout，保留后续 prepareEnvironment 的原受管命令、版本/源码检查与关闭断言，完整成功 check、publish/verify 继续使用原受管 checkout。该候选属于测试准备边界重组，没有生产算法修改，也不跨状态缓存观察。尚未实施，不能声称收益。

仅加入透传计时和受管命令数元数据后，用准确文件与两条名称正则运行基线。session 25434，经独立 require_escalated 审批，于 08:08:52.6719255Z–08:09:01.5765920Z 执行，8.9029956 秒、exit 1；第一条在 prepareCheckout 之前返回 BUDGET_EXCEEDED / SLOT_ADMISSION，第二条因首个失败未执行。其余三条是本次精确过滤未选中，没有新增源码 skip。Job e38b14d4-c66d-4196-830c-4ab3593479a0 于 08:09:01.509Z 确认 closed/normal/empty，1 worker 峰值，active=0、remaining 为空，宿主退出、日志排空，没有超时或强停。

08:11:08.3901426Z 的只读卷观察为可用 5,152,415,744 字节，低于夹具原有 5 GiB（5,368,709,120 字节）下限，尚需保留原 1 MiB 元数据预留。该观察不是失败瞬间的采样，SLOT_ADMISSION 也包含大小条件；但当前空闲空间已不足以重试原准入。一次诊断公式误输出 10 GiB，已对照源码更正为 5 GiB，不据此改变门槛。已核两处本任务完成证据合计仅约 27 MB，不足以补足缺口；未删除证据、共享缓存或未知资源，未修改预算。

立即停止本次比较，未运行候选或全量。透传计时补丁已从测试源码移除，诊断版本与失败证据保存在 .tmp/content-checkout-20261027；基线输入清单 SHA256 为 c4d3b5526dad3ec571541f1b2452677fffb98f3e443c6a665f411296511a9d55。恢复前先满足原磁盘准入并核对准确测试集合，使用新的运行目录及具体命令审批，不能清除旧 claim 或盲目重跑。此磁盘阻塞不是前次全量性能回退的归因。

另纠正窗口证据边界：D 结束后主任务和 reviewer 曾执行共 10 次 PowerShell 只读命令；只读不等于没有新 OS 命令宿主。已知记录缺少完整创建时间、PID 和创建标志，不能把这些调用数与用户观察到的 7–8 个瞬时窗口逐一对应，亦不能将窗口归因于已清空的 D。当前执行器外层及全部原生后代的可见性仍未验证。本轮未提交、推送或触发 CI。

用户随后要求先反查本项目临时资源。仅扫描仓库 .tmp 元数据并跳过链接、共享/归属未明缓存：当前失败没有留下新 fixture；managed-release-tests 的 9 个旧目录合计 581,020 字节，owned-scope-tests 与 managed-budget-tests 为空。普通失败路径会等待 pending 任务并 dispose，硬终止可能绕过 worker 的 afterEach；现有旧目录时间只能提示这一风险，不能证明精确所属运行或现在无人使用，尚无本次正常失败清理代码遗漏的证据。

较大历史目录包括 ss2-read（约 1.15 GB）与 release-portability（约 581 MB）；这些是逻辑文件长度，不代表可回收物理空间。后者包含源码和指向共享依赖的链接，前者含历史快照/验证产物；没有确认可丢弃且无占用的精确子集。check-cache 保留，check-runs 的约 96 MB 日志/覆盖率/关闭证据也未删除。未归档、移动或永久删除任何资源，不请求直接扩容。恢复比较仍缺原磁盘准入余量，以及由资源所属任务确认的可恢复回收对象；详细范围与不确定项见 .tmp/content-checkout-20261027/cleanup-assessment.json。

### 两条失败机制的前置 checkout 配对与临时资源收尾

2026-10-27，仍为 dev / `96cd5c8c1b2124de96c112c4b8447ef12210f515` 加未提交差异。08:28 复查发现 `ss2-read` 已不存在，09:02 空闲空间为 40,962,490,368 字节；不是本任务删除或释放，当前没有需批准永久删除的精确历史子集。`release-portability` 和 9 个旧 managed fixture 继续保留，未扫描共享缓存或降低 5 GiB 准入。

同一 `managed-release.test.ts`，仅选择「stops after a preparation command modifies committed source」和「refuses a different pnpm version before frozen installation」。baseline/candidate 都经过具体命令审批，使用正式 context/observer、1 worker、150 秒工作及 10 秒收尾；两份 2362 项输入清单仅该测试文件的两处 `fixture('component')` 选择不同。基线清单 SHA256 `e3f3c91a29aa8c93a47a666fb9f51ce2338f17996d7ee1384820d447cbe43066`；候选 `91137fd4948664716c804582a5473ce2439c37c323f91c357ad536d358d2605d`。

| 指标 | 原受管 checkout | 仅前置 checkout 使用既有组件 helper |
|---|---:|---:|
| 宿主墙钟 | 70.7219021 秒 | 43.2818892 秒 |
| 两次 checkout 准备 | 32.5934228 秒 | 5.3278554 秒 |
| 准备阶段受管命令登记 | 22 | 0 |
| 两例测试体扣除 checkout | 34.4732464 秒 | 34.5638647 秒 |
| 通过/失败 | 2/0 | 2/0 |

session 92092 于 09:03:16.3984651Z–09:04:27.1214369Z；session 68951 于 09:13:08.9677630Z–09:13:52.2510726Z。两次 exit 0、日志排空、峰值 1、active=0、remaining 为空，Job 分别于 09:04:27.079Z 与 09:13:52.204Z closed/normal/empty，无超时或强停。宿主减少 27.4400129 秒（38.8%），与准备成本减少 27.2655674 秒相符；没有推断机器占用。其余三例只是准确过滤未选中，源码无新增 skip。真实独立 Git、来源新鲜检查及目标安装/准备的受管失败机制保留；完整成功 check、publish/verify 未替换，也未在本次重跑。这是局部保留候选，不证明完整检查不劣于 1302.75 秒或达到五分钟。

新发现并修复两处资源链：`publishCoverageReports` 在成功、复制/汇总失败及回滚成功后删除本次暂存，只有回滚失败保留恢复数据，清理失败仍报错；实际函数的纯文件系统注入原实现 4 fail/1 pass、修复 5/5。`runTestProcess` 创建并记录唯一短路径 Job 临时根，`managedFixture` 显式采用；父侧确认空 Job 且 dispose 完成后核对路径和文件身份再删除。关闭未知或身份变化时保留，不能清理历史目录。两次真实运行各两个 fixture 及 Job 根都移除，`.tmp/test-work` 前后为空，9 个历史目录不变。卷空间差值包含其他活动和保留日志，不等同于 fixture 残留；原始逐路径证据在 `.tmp/content-checkout-paired-20261027`。

临时目录原生红测试先确认缺少 Job 归属变量；随后 33 项注入/文件回归中 28 pass、5 fail。5 项 coverage 发布回归因 Node 权限模型的 `fs.cp` 需要读取 `\\?\E:\source\ai` 祖先元数据而拒绝（`ERR_ACCESS_DENIED` / `FileSystemRead`），不是工具自动审批拒绝；未扩大仓库读取范围或盲目重跑。纯注入通过不能替代该原生复制检查。

取消回归自身另有真实日志目录未清理。新增嵌套回归在 09:18:48 UTC 先观察 1 fail/1 pass，原因是 finalize 后目录仍存在；只为 7 个现有假进程 context 和该回归增加基于终态、精确路径及目录身份的清理。复验 session 52299 于 09:20:27.0778686Z–09:20:27.3975080Z 执行，0.3209571 秒、27/27 pass，0 fail/cancel/skip，exit 0。单 Node 权限仍禁止子进程、Worker 和 addon；其 2363 输入清单 SHA256 `6fbd0bf0e2949e5483d5058ad00ec22d6ea8e7bdb22d25846412540df1852c36`。`check-runs` 前后均 195 个，新增/删除差集为空，`test-work` 为空；证据在 `.tmp/context-fixture-cleanup-20261027`。

未验证项：真实取消/超时后的磁盘回收、其他尚未采用 Job 临时根的夹具、宿主硬崩溃恢复、正式证据有限轮转、原生 coverage 复制及最新完整验收。测试通过和 Job 空不能掩盖这些缺项。当前保留这次失败/配对/清理证据以支持审查，不新增历史自动清扫；必要证据被持久摘要和后续验收替代后，仍按具体归属和删除授权处理。外层宿主及全部原生路径的无闪窗状态仍未证明。未提交、推送或触发 CI。

最终静态检查先定位两类代码问题后最小修复：`no-unsafe-finally` 的两个 throw 移到同文件私有清理函数，删除条件、原异常与失败终态不变；四处 `TaskMeta` 缺失字段补 Vitest 接口声明，不改变运行时。清理/取消复验于 09:29:16.1230561Z–09:29:16.4494303Z 完成，27/27 pass、宿主 0.3283188 秒；最后 release-vercel `tsc --noEmit` 于 09:32:57.8717859Z–09:32:59.7152092Z 通过（1.8456363 秒），全仓 lint 于 09:33:39.5868668Z–09:33:55.9950200Z 通过（16.409425 秒，0 errors、0 warnings）。各次均独立正常工具审批、exit 0、自然退出及日志排空；没有取消、超时或强停。最后静态输入 2365 项，清单 SHA256 `597a1599f3e472490ea7fae31551f5c53cb3e39e727c89019bd1efe0de1090fa`；本段在检查后追加，属于文档漂移。原失败与 claim 保留，代码修复后没有重跑性能两例或完整检查；完整验收仍未通过最新组合。原生证据见 `.tmp/context-fixture-cleanup-lintfix-20261027` 和 `.tmp/content-checkout-types-20261027`。

### 清理安全复核与元数据授权粒度：真实探针暂未执行

独立 reviewer 在 09:43 UTC 只读审查确认一项新增 P2：`runTestProcess` 将 `realpath(repo/.tmp)` 直接作为信任根，预置指向仓库外的 `.tmp` junction 可让新工作目录在外部创建、删除，不需要竞态。另有既有 helper 缺口：A fixture 根被替换成指向同 base 内 B 根的 junction 后，`dispose` 只凭 realpath 包含关系可删除 B。真实取消/超时删除探针因此未启动，不能以正常路径成功覆盖这两项缺口；本轮尚未修改其实现。最小修复须先拒绝重解析根并记录、复核 fixture 身份。删除前检查与 rm 之间仍是未验证的并发边界，不伪称已复现或已原子防护。

退场正向证据仍是 termination → dispose/completion → 空 Job 判断 → 临时根清理 → context 租约释放；原始错误及根外日志保留。reviewer 本轮只有一次仓库内 PowerShell 文件读取，没有测试或 Node/Git 启动，外层宿主隐藏未证明；未重新读取 Provider 的 empty 合约。本轮计划仅真实取消、真实计时器到期两个自有 fixture，1 worker、每项最多 150 秒工作加 10 秒原收尾；须先修复上述缺口。精确断言、停止条件和证据限额建议在 `.tmp/cleanup-safety-review-20261027/remaining-plan.md`，该计划不是可执行或已通过的探针。

用户仅批准 coverage 五项所需祖先元数据读取。旧错误栈明确是 `fs/promises.stat` → `checkParentPaths`，`ERR_ACCESS_DENIED` / `FileSystemRead`，资源为 `\\?\E:\source\ai`，没有 syscall 字段；不是已证实的 Windows ACL 拒绝。旧日志未记录随机复制源/目标全路径，fixture 已清理，无法补做当时的 realpath 证明。代码路径是项目 `.tmp/tests/coverage-publication-*` 下的 jobs/coverage-jobs 报告目录复制到同一运行根的 coverage-publish/new，未发现外部源码或共享依赖作为复制源。

当前 Node 为 24.11.1。[同版本 cp 实现](https://github.com/nodejs/node/blob/v24.11.1/lib/internal/fs/cp/cp.js#L147-L174) 沿目标祖先调用 stat 防止复制进自身，不会因到达项目根自动停止；按本布局还可能检查 `E:\source`，此项是源码推导，未实际访问。[同版本权限说明](https://nodejs.org/download/release/v24.11.1/docs/api/permissions.html#file-system-permissions) 明确已有目录的 allow-fs-read 会扩成子树，CLI 无法表达仅目录元数据。因此没有把批准扩大成父树读取，没有重试五项，也未改变复制实现、关闭权限模型或以另一工具完成被拒操作。独立的内置源码检查于 09:42:56 UTC 因 `process.binding` 被 Node 权限模型拒绝，立即停止未重试；随后只阅读该版本公开源码，不执行内部绑定或复制。

证据有限保留仍只是建议：最多四组完成运行原始证据（最近全量通过、当前全量失败、当前配对两组），每组建议 50 MiB、总计 200 MiB，长期摘要每组不超过 256 KiB。活动、未知归属及回滚失败恢复数据不能为了额度自动删除，超额应先停止新增实验并处理保留项。本轮未实施轮转或删除历史证据。review 与权限分析汇总在 `.tmp/cleanup-safety-review-20261027/outcome.json`；代码保持未提交，未跑全量。

### 两处清理身份缺口已修；取消探针断言错误与复制权限仍待解决

2026-10-27，`dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515` 加原未提交差异。新增 `ensureTestTemporaryDirectory`，逐层 lstat 拒绝 `.tmp` 及其祖先段的 junction/非目录后才继续创建；context、进程日志/Job 临时根和 managed fixture 复用它。fixture 记录 BigInt dev/ino 和 canonical root，dispose 拒绝替换，始终针对原路径删除。原实现的两项纯注入先失败，修改后两项通过；独立静态复审无新阻塞。检查与删除之间的并发替换没有原子保证，不外推为该竞态已解决。

| 验证 | UTC / session | 真实结果 |
|---|---|---|
| 三文件清理/取消回归 | 10:10:44.883–10:10:45.256 / 57473 | 33/33；单 Node 禁止子进程/Worker/addon；其中两例在项目测试区模拟根/祖先 junction，哨兵不变 |
| release 类型检查 | 10:26:18.102–10:26:20.143 / 54371 | exit 0，2.0428985 秒；先前 `it.each` context 类型失败已改为同样两例的显式声明 |
| 两例真实 Git 根替换 | 10:26:47.792–10:26:52.706 / 88702 | 2/2，4.9121669 秒；其余六例仅未被本次过滤选中；四个 fixture、Job 根均移除，独立哨兵和 HEAD 保持 |
| 真实取消磁盘探针 | 10:27:25.357–10:27:26.492 / 63149 | exit 1，1.1323139 秒；探针错把主动终止要求成 `closed`，实际 `unknown/terminated/empty=true` |
| 全仓 lint | 10:28:59.424–10:29:12.671 / 36023 | exit 0，13.2486767 秒，0 errors / 0 warnings |

真实取消保留原 AbortError，Job 于 10:27:26.448Z 提供空集合证据，随后 dispose/租约完成；峰值 1、active=0、remaining=[]，父侧移除含 checkout/pack/coverage-work 共 12,288 字节有效载荷的自有根。探针在严格状态断言处失败，后续哨兵内容读回、取消后禁止再启动和收据断言未执行，不能计为通过。哨兵由探针 finally 清理，事后不能补证其内容。已停止该序列，timeout 没有 run.claim，也未重跑取消。下一次只修正探针对既有终止契约的预期，并让清理与哨兵取证独立于先前断言；不得改变 Provider 成功条件或放宽 empty 要求。

用户明确批准仅该 Node 测试进程临时读取 `E:\source\ai` 整个父树后，原 coverage 五例只做了一次实际重试。首次启动因 `--import` Windows 绝对路径不是 file URL 在收集前退出（0 测试/0 复制），保留旧 claim 后，仅修正 URL 并独立审批。实际 session 4307 于 10:15:51.969–10:15:52.210 执行，0.2428669 秒、exit 1、0 pass/5 fail；第一个 cp 被 `ERR_ACCESS_DENIED / FileSystemRead` 拒绝，资源为 `\\?\E:\source`，后续复制由探针保留同一拒绝而未再调用 cp。未扩大到更高祖先、关闭权限模型或替换复制实现。

首个完整源为 `.tmp/tests/coverage-publication-3EBy77/jobs/a/coverage`，目标为同一自有根下 `coverage-publish-gpPJ7y/new/0`；源 realpath 与目标父 realpath 均为原项目内路径，检查段无链接。拒绝来自 Node 防自复制祖先校验，未发现外部源码/共享依赖复制。窄查现有脚本与 repository-files 只找到单文件 copyFile 或同样的 fs.cp 调用，没有已证实可等价复用的目录复制实现；不为绕权限引入另一实现。精确调用和拒绝见 `.tmp/coverage-metadata-retry-urlfix-20261027/green/copy-paths.jsonl`。

本次源码/产物最终冻结 2376 项，清单 SHA256 `4f852b4e844834e07d3599fe96b64d4df37c7df23093fb2e21dc435b1d6dab80`，10:30:31Z 审计无漂移；本条及技能补充写在审计后。`.tmp/test-work` 仍空，`.tmp/tests` 前后只有相同两个历史目录，coverage 本次根、四个 Git fixture 与取消根逐路径均不存在，九个历史 managed fixture 未动。可用空间 40,504,180,736 字节；本轮精确八个证据目录在审计时合计约 4.89 MB 逻辑长度，作为当前失败/回归证据保留，未实施历史轮转。详见 `.tmp/cleanup-native-owned-20261027/final-audit.json` 及各 stage 的 inputs、launch-status、result、process/temporary/worker 记录。

全部本次执行使用各自具体命令审批，仍为 1 worker、原 150 秒工作加 10 秒收尾，静态检查单 Node 上限 60 秒；无宿主超时或强停。窗口没有直接观察证据，不宣称全部路径无闪窗。最新完整验收、非回退目标和长期崩溃/证据回收仍未证明；无全量、提交、推送或 CI。

父任务随后要求继续原取消/超时小集合。只在新的 `.tmp/cleanup-native-contractfix-20261027` 修正探针：要求 `unknown/terminated/empty=true`，并在任何前序断言失败后仍独立读回哨兵，内容核对后才清理。原生失败样本在旧断言下不被接受；修正后的五种纯内存形态核对全部符合预期，正常成功、非空、缺少空集合或 provider-failed 均不会被当成预期取消。生产契约和删除边界没有因此改变，旧 claim、探针和输出保留。

取消 session 60220 于 10:36:30.4438928Z–10:36:33.3977636Z 通过，宿主 2.9716742 秒；超时 session 84676 于 10:37:10.6708892Z–10:37:12.9718234Z 通过，2.3012553 秒。两条具体命令独立 require_escalated 审批并串行执行。取消保留原 AbortError；真实 1 秒计时器到期保留 TimeoutError/code 23。两者均确认失败收据、取消后零新启动、峰值 1、active=0、remaining=[]；Job 分别于 10:36:33.141Z、10:37:12.887Z 提供空集合。每项 12,288 字节有效载荷及其自有临时根移除，独立哨兵 SHA256 均为 `99d7980dd6d8dba87c4ec97f0adf8dcbe681599f59765de6999afb52232b4e03`，核对不变后移除。探针 exit 0 代表这些断言通过；任务本身仍记录 failed=true，不能改写成正常完成。

最终输入 2380 项，清单 SHA256 `a066aff6a9908c0dd486fed3e36f337536b605998b086cfb8053372c057e700c`；10:38:32Z 审计无漂移，七个本轮代码/测试文件的独立哈希也已记录。工作根与每个 payload/哨兵逐路径不存在，`.tmp/test-work` 空、`.tmp/tests` 前后集合不变；可用空间 40,459,468,800 字节。新增探针及两个 context 证据在审计时合计约 795 KB 逻辑长度，保留当前失败与通过对照。详见该目录 `final-audit.json`；JSON 回读使用 DateKind String 保留原 UTC 字符串和不透明 startToken，不能让 PowerShell 自动转换身份令牌。此补充在输入审计后追加，没有重复类型检查、lint、Git 安全用例或全量。

coverage 权限只做源码推导，没有再次执行。按已读 [Node 24.11.1 checkParentPaths](https://github.com/nodejs/node/blob/v24.11.1/lib/internal/fs/cp/cp.js#L147-L174)，此次目标的祖先 stat 链是 `coverage-publish-*/new → coverage-publish-* → coverage-publication-* → .tmp/tests → .tmp → foundation-forge → E:\source\ai → E:\source`；当下一祖先为 `E:\` 时，在 stat 前直接返回。相同源父目录、盘根或 ENOENT 会停止；其他错误及源/祖先身份相同则抛出。已读五例只生成项目内普通报告文件，后续复制/目标检查仍在项目内。Node CLI 对存在目录不能只授权元数据，因此保持该版本、路径布局和权限模式时，可表达的最小一次性选择为该进程 `--allow-fs-read=E:\source`（整个子树，包含其他项目），写权限仍仅本仓库 `.tmp`，无子进程/Worker/addon、宿主 30 秒。此范围尚未批准，亦未尝试；更窄的已批准 `E:\source\ai` 不足，不能让用户逐级试批，也不以新复制实现绕过。该结论限于这五项和已读版本，不承诺其他未来路径没有额外需求。



### 已批准完整父树读取：coverage 四项通过，一项准备阶段失败

2026-10-27，用户新批准仅原五项的单 Node 进程临时只读 E:\source 子树。正常工具审批后，session 60974 于 10:48:58.3291277Z–10:48:58.9116664Z 执行一次，宿主 0.5878597 秒、exit 1；测试 5 项、4 pass/1 fail、0 cancel/skip，测试器计时 319.1373 ms。写权限仅本仓库 .tmp，禁止 child_process/Worker/addon，总宿主 30 秒（20 秒工作及 10 秒收尾预留），自然退出、日志排空，无超时/强停；没有后续重跑、全量或提交。

成功发布、回滚失败保留恢复数据、汇总写失败、最终替换失败四项通过，共记录 8 次真实 fs.cp；完整源/目标及 realpath 均为本项目自有 fixture，路径段没有链接，cp trace 没有新权限错误。第五项 keeps every old report when a later report cannot be copied 预期裸 ENOENT，实际收到 AggregateError，在它自己的复制阶段之前失败；该例的旧报告/暂存后置断言未执行。外层聚合异常的内层错误没有被 spec 日志保留，不能断言不存在其他权限失败，也不能把预期直接放宽为任意 AggregateError。静态调用链显示准备过程在假的 context.execute 之前仍调用 Windows pnpm CLI 定位，依赖 npm_execpath/PNPM_HOME/PATH；这是具体待核候选，不是已证实根因。下一步只需展开这一失败的内层原因并修正必要的自包含前置，不扩测试集合或权限。

本轮没有修改源码；2382 项冻结输入清单 SHA256 为 76c6c7b244e8e2314b88fd5737b41212c22490d1b1b7ee98ee2096ff5c55e109，10:52:01Z 审计无漂移。run-workspace-coverage.mjs 为 c08fa416b356ad29b800c88c75d7ee5751ef7b3a263a9ef09af437684156b9c5，workspace-coverage.test.mjs 为 c4732d850cedcfbcebc43b1f1cae937ca4d27c79e388322116da0295b441d58b。四个 trace 对应 fixture 根已不存在；.tmp/tests 前后都是同样两个历史目录，差集为空，.tmp/test-work 为空。独立 48 字节哨兵前后 SHA256 均为 5325d1a371195f4c9b8842d125544262896004bdc7273a7aac956968b8b232f9，作为本轮失败证据保留，历史资源未动。当前空闲约 40.73 GB。完整命令、计数、源码哈希、路径和收尾见 .tmp/coverage-parent-tree-approved-20261027/outcome.json；技能补充在审计后写入。最终全量入口尚未就绪，须先解决这一个定向失败；不把权限通过或四项通过当作整体通过。
### coverage 第五项的环境依赖已证实并修复，原五项通过

父任务授权一次单例内层诊断。session 75033 于 10:58:26.6336458Z–10:58:26.8294860Z 结束，0.198648 秒、exit 1、1 fail。完整 errors 证实两个任务均在 findPnpmCliPath 的 existsSync 被 Node 拒绝读取 C:\Users\Administrator\AppData\Local\pnpm\pnpm.cmd；npm_execpath 未设置，生产聚合发生在 context.execute 和发布复制之前。保留具体拒绝，没有扩大读取范围或再次访问该 shim。该诊断没有启动复制，.tmp/tests 前后相同、test-work 为空；证据在 .tmp/coverage-inner-diagnostic-20261027。

根因是组件测试虽注入假的 execute，命令组装仍意外依赖宿主安装。最小修复仅改 scripts/tests/workspace-coverage.test.mjs 的第五项：本次 fixture 创建误执行即抛错的 pnpm.cjs，占位路径只用于命令组装；临时指定 npm_execpath，核对 fake execute 收到的 Node/入口参数，并由 t.after 恢复原环境。保持原真实 fs.cp、裸 ENOENT 和旧报告/暂存/恢复数据断言，不改变生产代码、复制实现、错误聚合或权限。实际 CLI 解析函数的纯注入先复现外部探测拒绝，显式自有入口后只访问这一入口；不是伪造复制失败。

原精确五项于 session 28715，11:02:49.4120091Z–11:02:49.6565795Z 复验一次：5 pass、0 fail/cancel/skip，exit 0；宿主 0.2461734 秒，测试器 144.8927 ms。独立工具审批，仍为临时 E:\source 读/仓库 .tmp 写，禁 child_process/Worker/addon，单隐藏 Node，总宿主 30 秒；根进程自然退出、日志排空，无超时/强停。第五项实际进入复制，第二个报告缺失产生原生 ENOENT/lstat，路径是自有 fixture 的 coverage-jobs/1/coverage；未放宽断言。npm_execpath 开始和结束均为空，恢复已核实。

本轮共记录 10 次复制调用：9 个存在源的 realpath 和全部目标父 realpath 均在项目内；预期缺失源的 realpath 为 null，已有祖先检查无链接，不伪造它的解析结果。五个 fixture 根逐路径均不存在，.tmp/tests 前后两个历史目录集合不变、test-work 空；独立哨兵 SHA256 5325d1a371195f4c9b8842d125544262896004bdc7273a7aac956968b8b232f9 不变，作为当前证据保留。冻结 2388 项，清单 SHA256 06fcbd516a6d1d5b5571dee1fb52d54627b533a64f17c5ad3f58e04baad52e62；11:04:39Z 审计无漂移。生产 coverage 源码哈希仍为 c08fa416b356ad29b800c88c75d7ee5751ef7b3a263a9ef09af437684156b9c5；测试文件新哈希为 7ff59d5be9fa97186871da9c1e421f8b42b63e9b18d6b00b521aae2b534586bd。完整证据为 .tmp/coverage-self-contained-20261027/outcome.json；本文在审计后追加。

定向缺项已关闭，最终组合全量前置就绪。当前 check 收据中的 test-process-runner/test-run-context 哈希与源码不同，按 selectCheckMode 会进入 full；复用既有 D 受管隐藏入口与其 full/complete 日志断言，保持共享 2 worker 和原时限。旧 D 的 claim 不复用；新运行仍须新目录、冻结当前输入及具体命令的独立工具审批。本轮没有启动 D、全仓 lint、其他测试、提交或推送；新测试前置改动仍须由下一次正式全量覆盖。局部通过不证明总体性能或全部路径无闪窗。

### 最终组合全量失败：真实后代收尾与注入用例临时根遗漏

2026-10-27，dev HEAD `96cd5c8c1b2124de96c112c4b8447ef12210f515`。新目录 `.tmp/test-time-final-20261027` 独立审批后只运行一次正式 `pnpm check`：session 70045，11:13:38.2069323Z–11:32:31.4773928Z，宿主 **1133.280207 秒，exit 1**。完整模式已由正式启动日志确认；驱动的 `fullMode=false` 是异常发生后未到日志核验分支，不能解释为运行了增量。脚本测试会输出假的 `check:full complete: 0.00s`，裸字符串出现不能证明全量完成。保持共享 2 worker、原单阶段时限、10 秒收尾、隐藏启动及全部原验收集合；未继承 coverage 单例的父树读取参数。中途工具执行环境短暂不可用，恢复后接回原 session，没有重启。

实际阶段：lint 18.88 秒、pack:check 251.16 秒、typecheck:built 15.70 秒、cycles 0.47 秒、脚本 93.22 秒；coverage 在第一个包后失败，用时 749.09 秒。49 个脚本文件的 363 项全部通过；release-vercel 38 文件、269 项全部通过，Vitest exit 0，但父侧 Job 返回 `unknown / descendants-remained / empty=true`，完整入口因此正确失败。余下 26 包未执行，覆盖率未正式发布；**本次耗时不能与成功全量 1302.75 秒直接比较，更不能认定不回退或达到五分钟**。

失败 scope 为 `287723ef-6886-486b-a180-0c3073ac4131`，根 PID 128892（仅历史身份，不得据此直接操作 PID）。11:32:28.900Z 已清空，外层 scope 于 11:32:31.360Z 正常关闭并清空。现有生产报告未保留收尾瞬间成员 PID/创建身份/映像，因此只能确定自然关闭门禁失败，**不能确定遗留后代的来源或把它归因 Git、pnpm 或新 helper**。下一步须从本 Job 的失败时刻证据定位；不得放宽原 1 秒判定、增加猜测重试或全局枚举。另一个 hidden-vitest-held-pipe 的相同 reason 是专门负例预期，须与本次非预期失败区分。

主 context `run-brwSmv`：26 个预算任务全部结束、active=0、remaining=[]、实际峰值 2。75 份主链及外层报告均为空 Job，记录的临时根逐路径不存在；15 个嵌套 context 另有 34 份报告，也全部 empty=true，总计保留 109 份进程报告。136 条实际 worker start 与 136 条 finish 对齐。release 生产源码覆盖与上一完整样本相同：39 文件，2168 statements、307 functions、1846 branches，映射与已覆盖集合无丢失；这只证明该包已有覆盖证据，不补足未执行的 26 包。

磁盘差集暴露此前定向验收未覆盖的调用方：`.tmp/test-work` 从空变为四个空目录 `r-eaTuf8`、`r-jhBE23`、`r-jIZ56j`、`r-Xn7lHw`，均创建于 11:19:47.154–.175Z，位于 `test-process-runner.test.mjs` 的执行区间。该文件四次 falsy setup rejection 注入返回无 completion、dispose 抛错，现有 finally 正确保留未证实关闭的根，而测试自身只删除日志 fixture，没有记录并回收这些纯替身目录。次数、时间和代码高度对应，但日志 fixture 已清除，不能逐目录补造身份凭据。保留这四个 0 字节现场，不擅自删除；下一任务先补调用方自有根收尾及精确差集回归，不可放宽生产删除边界。

`.tmp/tests` 两个旧目录与 managed-release-tests 九个旧目录的名称集合均不变；package-verification 无残留；本轮未创建 coverage 发布暂存。新增 16 个 check-runs 目录共 2,492,080 字节，包括主失败证据和 15 个嵌套测试证据，暂保留。有限证据轮转仍未实现，不能声称长期不累积；历史目录的运行前快照只有浅层清单，不能据此声称其递归字节完全不变。空闲空间从 40,697,618,432 到 40,687,566,848 字节是观察值，不能把整卷变化归因本任务。

运行冻结 2390 项清单 SHA256 `9c7f1b4d93a6593f7a53b1d8568e1987055054d82340993ae39ec3aa2f78fdfb`，终态回读无漂移；20 个 tracked 修改和 16 个 untracked 文件，tracked diff SHA256 `59e5cb42dd6e604573676ec3a37b4bc78820ea3a9cec09a7d361971cf3ec40ec` 不变。本条在审计后追加。完整证据见该目录 `final-audit.json`、`nested-cleanup-audit.json`、`context-proof-audit.json`、`git-after.json` 与 `handoff.md`。无提交、推送、CI 或自动重跑；外层命令宿主的可见性仍无直接证据。

局部两例配对收益仍为 70.7219021 → 43.2818892 秒（减少 27.4400129 秒、38.8%），不因本次失败升级成全量收益。当前 managed-release 文件 352.05 秒，仍高于成功基线的 322.08 秒；其中真实发布成功用例 228.777 秒是后续内容分析候选。先解决实际收尾和磁盘残留，再核该用例的准备/检查/验证执行次数与职责重叠；保留两真实 refs、真实冻结安装、发布与失败恢复，不预设删除步骤可行。此用例已超过定向 150 秒工作预算，不能直接在原小预算下整例重跑或自行加时。当前任务依最新指示停止新增优化与测试，由父任务交给新 Sol 6.1 xhigh 任务继续。

### Sol 接续：falsy 测试收尾闭环与一次完整复验，功能通过但性能不达标

2026-10-27，仍为 dev / `96cd5c8c1b2124de96c112c4b8447ef12210f515` 加前任务未提交成果；未重新全仓审计，未提交推送。

- 原四次 falsy 异常注入从未启动 OS 进程，却因为没有 completion 且 dispose 抛错而留下空 Job 根。生产 fail-closed 保留行为不改；仅测试 fixture 在取得收据、核对自有路径/身份后用 rmdir 回收空根。嵌套测试后逐根 ENOENT 的红测试确实失败（0.1163471 秒），修复后同集合与生命周期 12/12、0.4210477 秒。旧四空根逐项核实后可恢复地移入本轮证据区，0 字节，不计释放空间。
- 补入测试适配器 `test-process-diagnostics.mjs`：只观察 Provider 已确认归属的成员句柄，失败收据最多每根 64 项 PID/创建 FILETIME/映像 basename/最后活跃状态；不全局枚举、不改变原 1 秒自然退出判定或终止权限。纯诊断先红后绿；真实 detached 后代原负例 1/1、3.4467958 秒，实际成员证据与磁盘清理通过。CLI 两例 2/2、2.9129882 秒，未复现旧后代失败。**旧根因没有修复，不能把本次自然通过写成已修复。**
- 正式全量 session 17044，UTC 12:05:39.0275014Z–12:28:12.2411874Z，exit 0，内部 1350.70 秒、外层 **1353.2158718 秒**。相对成功基线 1302.75 秒慢 **50.4658718 秒 / 3.8738%**；性能 FAIL、5 分钟未达到。不能归功为提速，不能仅归咎电脑占用。
- 阶段秒数：lint 16.75、pack 270.77、type 12.88、cycles 0.45、scripts 92.46、coverage 957.38。50 脚本文件 368 PASS；27 包 189 文件 1410 PASS、仅原有 3 平台 skip。包 NOT RUN=0，零警告 lint、真实 tarball/浏览器边界通过。
- release 38 文件 269 PASS；墙钟 813.9383625 秒（成功基线 794.0116911 秒）。managed-release 文件 408.410 秒，成功发布+冻结验收+verify 单例 258.2386106 秒（上次失败全量该单例 228.777 秒）。本轮未替换完整成功链、未实现新的内容提速；该整例超过原 150 秒定向预算，没有另行扩限启动。完整成功发布/verify 的唯一集成职责不能简单套组件替身去掉。
- release 原 39 个生产文件、2168 statement / 307 function / 1846 branch 命中集合及映射无损。136 个过程报告全部 empty=true，102 个主链/外层均正常关闭；唯一 unknown/descendants-remained 为已有 held-pipe 预期负例且真实清空。主预算 52/52，实际峰值 2、租约和 remaining 均零。
- test-work/tests/9 个历史 fixture/package-verification 前后名称差集均空，报告中的 Job 临时根实际全部不存在。16 个新 check-runs 验收证据共 14,169,523 逻辑字节，本轮证据根审计时 6,189,690 字节，随后仅追加摘要；主动保留证据，不宣称零证据增长或已实施轮转。共享缓存和未知历史未清理。
- 冻结输入 2396 项，SHA256 `dcbc32bad15655bba298ca459fd3f34aac75bbffff27ffc7ec22ee73f30acb2c`。结束后 launcher 全清单门禁通过；限权 Node 独立核对仓库内 2392 项无漂移，4 个外部 Node/pnpm 运行时文件仅采用 launcher 核对证据。首次 Node 审计因 repo-only 权限拒绝读取外部 node.exe，立即停止该读取；后续 Node 未扩权限。本段在全量及终态审计后追加，是唯一预期文档漂移。

原失败、配对、正式复验和资源证据在 `.tmp/sol-test-performance-20261027/`，正式 context `.tmp/check-runs/run-2ehyJg/`，详见 `handoff.md`、`final-audit.json`。当前无活动测试、观察器或审批待决。性能目标、旧收尾根因、硬崩溃清理、并发目录替换原子性、全路径窗口证明和有限证据轮转仍未解决；不要盲重跑或放宽边界。
### Consumer 固定 Git 历史准备：一次精确短对照，算法成立但本接入方案不采用

2026-10-27 12:51:45–12:54:20 UTC，仍为 `96cd5c8…` 加原 40 文件未提交成果。按当前指令没有再次运行 full，保留清理/隐藏/失败诊断补丁；旧 descendants-remained 仍不是已修好。

只检查了 release 成功用例与 consumer 的既有证明职责，没有扩散全仓。alpha 的 SDK 成功/CRLF/历史退役拒绝，与 beta 的真实 postinstall 失败后 CLI 恢复各有独立用途，全部完整入口不削减。选定唯一短候选：consumer 每个固定初始两提交输入仍有 12 次 Git 准备调用，试用已验证的真实 fast-import 五次准备法；其余实际 check、恢复、身份和安全门禁不变。预先登记的上限约 3 秒，不把 231 秒 smoke 全部称为准备成本。

- 同集合为三组 alpha/beta，共六个新建独立仓库；1 worker、150 秒工作 + 原 10 秒收尾，正式 context/Job、固定隐藏 pnpm。检查两提交父关系、真实索引/双 refs、所有初始/候选 blob 的逐字节内容、Git fsck、Consumer 身份、alpha CRLF，以及后续真实 commit/push。没有使用历史目录、共享对象库、成功凭证或替身目标行为。
- baseline session 61980，UTC 12:51:45.7073482Z–12:52:15.8227200Z，宿主 **30.1178819 秒**。所有语义检查通过后，唯一红断言是准备调用 **72 > 30**；六仓准备总时间 **10.7951472 秒**。
- candidate session 21026，UTC 12:54:02.1071437Z–12:54:20.4174891Z，宿主 **18.3101671 秒**。同一文件、同一集合通过，准备调用 **30**、总准备 **2.4484384 秒**，准备成本少 **77.319%**。测试文件和声明字节前后不变，只有准备实现变化。
- 真实两个消费者每对平均准备节省 **2.7822363 秒**，不等于完整 smoke 或 full 的实测改善。它远不足抵消 50.4658718 秒全量回退。若把这组六仓性能/语义对照直接加入常规 coverage，会新增约 18 秒包工作并抵消准备收益；因此**当前接入方案 No-Go**，未接入实际 verify.mjs，也未申请/启动下一次 full。这不否定五次 Git 算法；若未来复用现有等价回归而不增加常规成本，可用新的净收益证据重开，不重复这一版重型回归方案。
- 两轮 Job 均 closed/normal/empty，峰值 1、租约和 remaining 归零；12 个 fixture 根和两个 Job 根实际均不存在，test-work 与 9 个历史 fixture 名称差集为空。无活动 session、取消、超时、强停或权限阻塞。
- 三个本轮新增的准备 helper/声明/性能回归已逐文件可恢复地移入 ignored 实验证据，没有永久删除；正式源码和原消费者入口恢复为上一轮状态。新增实验文件不成为正式测试的前提，不把重复采样放进常规 coverage。

原型、精确候选/覆盖矩阵、输入哈希、baseline/candidate 原始结果及归档源码在 `.tmp/consumer-history-20261027/`，入口 `outcome.json`。baseline 原实现已按原 SHA256 逐字节复原留档；两个清单 SHA256 分别为 `601f6f0ebb58cdcf4dd745c31a31fc74008d19dafc559e848ef4779cf7133e1f` 与 `aa1ede00df112bc0254aa0a5beca60efe449d2bec6c06b394e0190d73f8f8a6b`。没有提交、推送、发布或 CI。
### 发布/恢复结构静态筛选：当前未找到有证据支持60秒关键路径收益的最小项

按后续指令只读最近完整结果及 managed-release、push-resume、recovery-worker、resume 与对应组件；未新增/运行测试、基准或full，未改源码。最近最慢三例是成功publish→verify 258.2386106秒、dev push丢响应后正常入口重试90.6760096秒、未发布输入独立check 85.4510673秒。

成功链的verify没有再次安装/推送；其独特组合是消费真实publish产物并忽略后续坏配置，专门receipt/取消测试不自动替代这项组合证明。push-resume第二次publish不是多余重放：它必须依据新鲜远端观察不重推dev，仅补main，并保存unknown/terminal/history；它的checkout/environment和只读查询已经组件化。两个故障worker（73.7449065、63.3505109秒）各只真实publish一次，再recover；recover不重新publish。真实Git hook拒绝/更新、协调者退出/崩溃和缺失关闭凭证都是目标行为，不能手写状态代替。failed-install retry的真实两次pnpm同样是目标；closed/cancelled入口归档已在安装前停止。

release文件工作1608.412秒，双worker下界804.206秒，实际文件跨度810.766秒、Job813.938秒；接近满载，粗筛60秒墙钟约需120秒可删除worker工作。现有结果没有这些用例的publish/verify/故障前缀分别操作与墙钟；不能把整个258/90/85秒当成准备成本。已知checkout两例准备32.59→5.33秒的27.26秒收益已在当前组合内，不能重复计入新方案。

结论：当前没有满足“不变覆盖职责且有依据预计至少约60秒关键路径收益”的候选，不实施、不申请full；不是断言所有方案均不可能。若选择把源码完整check职责迁给tarball，或迁移真实publish→verify组合责任，属于改变当前明确分层矩阵，需用户先决定该方案，再证明行为及源码V8覆盖等价；普通fixture等价准备无需另行确认。静态短矩阵与明确边界在 `.tmp/release-structure-20261027/analysis.md`。无活动测试或权限阻塞。

### 用户批准的 quick/full 工作流分层：实施与完整验收前记录

2026-10-27，用户已明确批准日常受影响范围与快速回归、完整发布/恢复留在发版或显式 full 的分层。原完整性能 1353.2158718 秒仍比 1302.75 秒基线慢；此方案改变日常验证范围，不是完整套件达到五分钟或性能恢复的证据。保持全部原 full 用例、断言、coverage、skip、清理/隐藏修复及 main 自动发布规则。

复用原 selectCheckMode、工作区传递依赖与构建顺序、受管 context、脚本发现和 Vitest 预算包装。check/check:quick 运行 quick；check:full 明确完整检查、最后才原子写 validation.kind=full；内部原自动 runner 保留兼容。quick 不更新成功收据、不发布 coverage，输出精确 NOT RUN；冷缓存、删除/未知/共享工具或配置、未入选测试/helper、监督运行时重建等均要求 full。发布 normal/bootstrap 在入口、每次打包和 publish 前独立复核 full 输入/环境/dist/真实 tarball；resume 只处理验证、不执行 npm publish，因此无另加重复发布门禁。未触发 CI。

测试先红后绿：选择/门禁初始 3 FAIL、1 PASS，修复后 4 PASS；后续扩展到 8 PASS。独立复查发现 src 内测试可能漏选及普通 quick 阶段晚建 context，两个红断言复现后修复；普通 lint/build/typecheck 也经 context.run。9 文件原生定向回归最终 95/95 PASS、18.73129 秒，1 worker、150+10 秒，Job 与磁盘目录差集通过。新增 PATH 重复项回归先 94 PASS/1 FAIL，按完全相同项去重、保留首见顺序及原文后通过；实际查找顺序仍影响收据，其他环境检查不变。lint 首次两处 AbortController 全局写法失败，改为 globalThis 后零错误零警告、18.0762372 秒；release 类型检查 1.5917173 秒通过。两次独立静态复查无重要问题。

下一步只运行一次必要完整验收建立新的 full 收据，再单独计量实际日常 quick；完整与 quick 耗时、真实选择集合和收尾须分开记录，不用局部选择冒充完整成绩。证据入口 `.tmp/check-layers-20261027/progress.json`；本段在冻结完整输入前写入，最终结果只先写 ignored 证据，避免验收期间文档漂移。
### 分层后的首次完整验收：旧崩溃恢复用例 EPERM，日常成功计量被阻塞

2026-10-27，完整 session 76834 从 14:49:43.5137848Z 到 15:04:49.3905198Z，905.8814393 秒、exit 1；这不是完整成绩，不与 1302.75 秒成功基线作提速比较。阶段为 lint 17.23、真实包/消费者 236.38、类型 12.98、循环 0.46、脚本 95.31、未完成 coverage 539.04 秒。52 个脚本文件、378 项全部通过。

原有 managed-recovery-worker.test.ts 的 accepted remote push/coordinator crash 用例在到达 post-receive 屏障前退出：报告为 PROCESS_STATE_UNKNOWN / PROCESS_LIFECYCLE_FAILED / git-stream / EPERM，stage=push-dev，尚未尝试两次 push。仅结构化报告保留该代码，不能定位到具体 syscall 或 path，不能归因机器占用或判断为审批拒绝；本轮不放宽生产生命周期门禁、不改该断言、不盲重跑。release 实际完成 8 文件、106 PASS/1 FAIL，30 文件 NOT RUN；完整真实成功链因 bail 跳过一次，不能当原平台 skip；其余 26 包 NOT RUN。完整 coverage 无损比较尚未完成，原报告未发布替换。

失败终态 112 份进程报告均 empty=true，所有报告临时根实际不存在；主预算 26/26、观察峰值 2、active/remaining 为零。test-work、tests、9 个历史 fixture、package-verification 和顶层 coverage 暂存差集为空。冻结 1039 项（Git 源输入及本轮入口、显式运行时文件），清单 SHA256 57610af1e557324ace4373e9c4e73abe711c7fd95bb65427a592eab7b6371195，终态审计无漂移。旧 2396 项清单另含历史 ignored 诊断文件，不把清单规模差异当覆盖变化。新增 16 个 check-runs 保留失败证据约 955404 逻辑字节，不宣称零证据增长或已实施轮转。

随后只运行实际 pnpm check 入口 session 83569，15:08:46.1820018Z–15:08:49.0020723Z、2.8189901 秒，以 FULL_CHECK_REQUIRED 拒绝失效基线，符合 fail-closed 预期。该时间只是拒绝开销，不是成功 quick 耗时。full state.json 仍为 12:28:12 的旧普通收据，没有生成 full 标记；收据逐字节和 27 包既有 coverage-final 摘要均未变，目录差集为空、租约归零。受影响包实际 quick 与日常成功性能均 NOT RUN，不构造或伪造仓库 full 成功收据来计量。

实施与定向选择/门禁证据通过，但整体验收尚不可报告 PASS。EPERM 根因和新的成功 full 基线是剩余阻塞；保留所有分层实现及原安全/cleanup 修复，不提交推送。最终证据在 `.tmp/check-layers-20261027/`，入口 handoff.md、outcome.json、final-audit.json。此段是完整冻结审计后唯一预期历史文档追加；后续应先读取这些失败证据，不能重做泛泛扫描或直接重跑 full。
### 连接恢复后的精确失败复验与诊断增强

同机环境恢复后只读回读成功并补齐 handoff.md，未重启旧session。静态调用链缩小为 publication(push-dev) → assertFrozen → assertCheckoutFrozen → assertCandidate → git status --porcelain=v2 --branch --no-ahead-behind -z --untracked-files=all → streamGit → ManagedProcess.execute；组件只读helper不替换status，所以该命令仍受管。原报告closed且reason=PROCESS_LIFECYCLE_FAILED，说明后置持久化等路径可疑，但旧日志不足以认定具体syscall/path，不能事后断言rename根因。

在生命周期已知错误诊断中只增加固定causePhase、白名单causeSyscall、四种元数据basename causeFile；不输出原消息/完整路径/参数，不重试、不改失败判定和关闭逻辑。原错误码回归扩EPERM一例先红（1PASS/1FAIL，12.0456956秒），再同集合3/3 PASS、11.4598087秒；独立静态复查确认隐私/行为边界无重要问题，这不是根因修复。

原失败单例session67251，15:25:04.1537357Z–15:26:05.3404366Z、61.1864272秒，1/1 PASS，EPERM未复现。随后同文件族完整managed-process 15/15 PASS、53.0102629秒；新lint零错误零警告17.4570199秒，类型1.6182648秒。定向均1worker150+10秒，成功Job empty，租约/remaining零，test-work及9历史fixture目录差集空；没有因通过而抹去原失败。

下一次完整验收仅用于验证已获准分层在当前输入的完整质量并建立真实full基线，以便随后实测可判定影响范围的quick成功路径；不是为环境波动采样，也不把诊断增强写成EPERM已修好。失败则停止读取新具体边界，不扩大权限或盲重跑。保持1302.75秒完整基线，旧1353.2158718秒性能不达标结论。以下完整输入冻结后，结果先写ignored证据，避免记录漂移影响quick选择。
### full2 的 SSE 首失败与连接隔离候选 No-Go

full2 session84812，15:31:21.9113982Z–15:36:22.1175097Z，300.2086454秒exit1，尚未coverage。阶段lint17.07、pack239.78、type12.83、cycles0.45、scripts26.77秒。首失败为ab-eval-transport-observer.test.mjs的JSON error子例：期待147字节但收到空body；旧断言没有状态或row，无法唯一确定网络原因。39过程报告均empty、临时根不存在、25/25租约结束，目录差集空；1040项e980caaf13c223c0929f4ceb190f9c7ce4cca0265dce9bf0f1630f75cdd99235审计无漂移。该300秒不是完整成绩。

尝试fixture Connection:close隔离：首次17/18失败，原截断负例不再读出拒绝；显式chunked后仍失败，只有负例两端恢复keep-alive才18/18通过0.8216037秒。这提示修改连接行为可能改变负例边界。为验证临时端口/全局fetch池假设，用两个自有loopback端口反复绑定、相同147字节SSE，原版与候选各12次均200且逐字节相等，总0.3294867秒；没有获得因果证据。**全部Connection/TE/fixtureFetch改动已撤回，不采用，不将单次不复现称为修复。**

最终原协议/连接测试只保留诊断：读取body并close取得安全row后，额外要求status200，原字节deepEqual附row；原中断assert.rejects失败时附safe row后仍抛原错。没有减少用例、放宽断言或更改observer生产逻辑。该原18项18/18 PASS，0.9104951秒；独立复查确认仅5增1删诊断，lint零错误零警告18.930775秒。SSE与旧EPERM根因均仍未确认；后续失败可取得更精确边界，不能写成已修好。

下一次完整验收用于完成当前分层的质量验证和取得真实完整基线，以便随后实测实际受影响quick；保留全部原协议测试及新诊断，失败立即停止。不得造成功收据，quick拒绝保护的2.8秒不算成功耗时。详细原失败、撤回候选、受控对照与终态在.tmp/check-layers-20261027；新结果先写ignored以保持冻结指纹。
### full3 的确定超时与分页夹具内容修复

full3 session92077，16:00:32.7224786Z–16:23:32.3072723Z，1379.5886012秒exit1，不能与1302.75完整成功基线比较。全52脚本通过100.30秒；release38文件270项全部通过，旧EPERM所在两例也通过（accepted/crash84.268秒），但不据此关闭历史根因。随后source-snapshot通过，repository-context response-pagination最后跨代cursor例触发原5000ms超时（5456ms）；其余24包NOT RUN。合计覆盖结果526PASS/1FAIL为部分集合。114过程报告全部empty，临时根不存在、28/28租约归零，目录差集空，1040项1fc5bb3e2930cf6f87f12fa1ec7a0f648fc2bb1a97dbcb4619b3738260811e42审计无漂移。辅助driver原complete标记会误读嵌套单测模拟文本；它不是验收依据，原full3退出1和FAIL保留，新driver额外要求真实root exit0及正耗时标记。

此例唯一契约是真实cursor在新的generation下被拒绝，原通用夹具却两次build各45源文件（2基础+hub+40叶+巨大ASCII/UTF8）。仅此例改16叶且不生成两份无关巨大文本，各19文件，两次输入90→38；其他10例仍用原40叶与大文本，高入度分页首例仍要求见到40关系。保留真实build→query→改源→rebuild→旧cursor查询，4096预算和5000ms超时均不变；新增首轮exit0、cursor为非空字符串。未缓存跨代结果、替身化目标、放宽断言或提高worker。

1024/2048预算试案被新增首轮成功断言以BUDGET_TOO_SMALL拦下，未当成有效cursor测试；最终恢复原4096预算。最终同一失败单例普通模式1/1PASS，本体634ms（宿主4.274163秒），原文件11/11PASS（宿主9.412818秒）。再按full同coverage模式原11项11/11PASS，宿主19.3217922秒，跨代单例3371ms，原5秒门槛不变。隔离1worker与full2worker上下文不同，不将5456→3371当严格配对提速百分比。lint零错误零警告17.9695852秒，repository-context类型1.6085961秒，独立静态复查无取巧或覆盖削减。所有定向Job空、租约零、工作目录差集空。

后续只做当前修复后的必要完整验收，再按真实full基线计量实际quick；完整性能与quick范围继续分报，历史EPERM/SSE空响应仍未确认根因。最终结果先写ignored，避免冻结期间文档漂移。

### full内容继续筛选：退役旧格式夹具成本上限，No-Go

2026-10-27，dev / 96cd5c8c1b2124de96c112c4b8447ef12210f515，保留既有54项未提交成果。用户否定4.66秒微小收益，要求继续优化完整套件。最近完整成功full4为1298.0883491秒，旧基线1302.75秒；不是五分钟。该次release coverage 778.1504728秒，全部用例工作1536.5865454秒，双worker理想下界768.2932727秒，调度余量只有约9.86秒，不能通过提高并发或换顺序包装提速。pack阶段234.67秒、其余coverage约152.74秒、scripts98.90秒，仍须保留真实消费者和隔离/权限覆盖。

唯一测量候选是managed-retirement的旧格式输入准备：13例共151.48461秒worker工作；每例先生成现代真实关闭日志，随后主动删除terminal/closure并降为旧协议。考虑直接准备真实旧协议输入，但必须保留独立真实协调器/子进程身份、未知关闭状态、源/锁/归档原字节、故障时点及所有retirement目标调用；原现代关闭链不能删除。13例全部归零的理想双worker上限75.742305秒本身已不大，不能把它当候选收益。

只增加fixture分段计时，按原coverage模式精确选择“requires a snapshot-bound legacy origin assertion...”与“resumes after archive persistence and after lock release...”，原断言、timeout、bail及生产代码均未改变。正式受管context，1worker、150秒工作+原10秒收尾，隐藏pnpm；工具实际模式require_escalated。session65180，23:28:47.8216917Z–23:29:17.6089576Z，29.7873266秒exit0；2PASS，0FAIL，另外11例NOT RUN，其他包/full/quick/lint/types均未新增执行。

两例目标本体14.8821488/11.3095659秒；全部fixture准备6.3355775/4.8904051秒，其中仓库准备0.8706353/0.850155秒、现代关闭worker4.9950474/3.9978884秒，现代受管命令各1次。按12个适用旧格式例及双worker线性投影，整个关闭worker成本归零也仅约26.9788秒墙钟；整个fixture归零约33.6779秒，且真实替代准备不可能为零。这是定向投影而非全量严格上界，现有证据不足以支持约60秒完整关键路径收益，故No-Go：未实现替换、未运行candidate或新full，不以零碎收益包装成功。

计时插桩已按原SHA256 3515c0e31e61aa18fd327145fe27e68704b438646e13523ee304b0ecd37db5ae逐字节恢复；closed-managed-worker未改。旧EPERM/SSE/自然descendants根因仍未确认。本次Job closed/normal/empty，租约1/1归零、实际峰值1；自有临时根实际不存在，test-work/tests/managed-release-tests/release-vercel-tests/coverage-publication目录差集为空。工作证据保留、历史资源及共享缓存未动；外层无闪窗仍无直接观察证据。冻结1043项，inputs.json SHA256=382cc15a1a2dd97629e23268855b854fced8bbd90257328e23b177d2efd7b525；详细日志、计时源码备份、恢复核对在.tmp/full-content-20261027。

另一个静态排除项是把52个脚本合并进Node测试调度器：当前逐文件独立CLI及experimental-test-isolation=none刻意避免内部console-producing fork；批处理会重新引入已知Windows隐藏边界，不能为启动成本回退该保护。该项未实现、未测试，不重复旧pnpm/Git微优化或无证据连接改动。技能记录追加属于正式源输入变化；不得沿用旧full收据宣称当前全部指纹仍有效，也不得仅为文档变更盲跑一次full。下次需有更大净收益、明确安全等价的新证据再开候选。

### 故障发布组件的精确 status 查询：局部收益成立，生命周期责任尚待闭环

补充筛选规则：约60秒不是用户硬门槛。可组合且有证据的收益仍可继续评估；不能因一个退役夹具候选 No-Go 就认定全套已无优化空间。完整基线仍为1298.0883491秒，原基线1302.75秒，本轮尚未运行full。

只在测试既有只读组件白名单中增加 assertCandidate 的精确六参数 status 协议，不缓存 Git、不合并跨 await 的观察。生产代码、完整 managed-release 及 tarball 成功链未替换。新鲜状态回归先红 session77363，随后绿色42661；组件路由及真实脏树/SHA/分支回归 session45948，3/3 PASS、11.6204933秒。

真实拒绝main push并由退出后的协调器恢复：baseline88422为54.6941063秒，candidate97298为43.4848659秒；status真实执行均10次，受管10→0、普通0→10，安装/版本/check各1次。dev push接受后丢响应再重试：baseline89793为79.2420039秒，candidate85459为55.5160539秒；status真实执行均22次，受管15→0，安装/版本/check各2次。两组均固定同一用例和断言，冻结输入差异只在白名单helper；所有已完成Job为空、租约归零、自有目录差集为空。不能将11.2092404与23.72595秒直接相加成full墙钟改善，也不把install波动归因候选。

独立静态复核确认责任变化：普通Execution仍每次真实调用Git、同cwd/config/signal/timeout及原解析/错误路径；但status不再逐次经过ManagedProcess.guard、Git上下文拒绝/隔离、命令元数据注入、预算采样、身份/授权/终态持久化与scope关闭证明。原故障目标的push/fetch及应用命令仍受管，但通用进程安全测试不能自动证明精确status的所有故障时点。第二组局部coverage确有两个既有分支不再命中（execution.ts lifecycle stream、component-session.ts managed fallback）；第一组子进程运行dist，父侧41文件零点损失也不能证明子进程覆盖等价。**当前只作为有局部收益的未验收候选，不宣称覆盖无损或准许full。** 需补齐status专门责任回归及后续完整覆盖核对，不能改生产安全门禁换速度。

同时修正accepted-push崩溃夹具的旧全局进程枚举：hook自报PID后只按明确PID集合逐祖先核验，重新检查身份及父边后才用于自有后代清理。15项纯注入回归通过；真实单例session13254在62.7927374秒以OPERATION_ABORTED失败，未足以确定具体阶段。随后将同一链的初始/最终核验批量查询，三节点图查询7→3，先红56540再绿49256（15/15、3.6419895秒），10秒原预算不增。真实复验live-batch于2026-10-28T00:19:25.6162461Z启动，工具调用中断，没有result/process终态；仅确认记录宿主PID115724已消失，自有r-iHDJcn为空目录仍保留，Job关闭未知。该次不算PASS，也不重启原stage。历史EPERM/SSE/descendants根因仍未确认。

详细边界、冻结输入、对照及失败证据位于.tmp/fault-status-20261027、.tmp/status-push-20261027和.tmp/fixture-ancestry-20261028；准入复核入口为第二目录boundary-review.md。所有成果未提交；full旧收据不覆盖当前文档及测试输入。

父任务进一步明确：发现受管路径覆盖削弱，必须先停候选，不能用full通过掩盖。因此本status候选最终No-Go：helper恢复SHA256 bc90e84bc085d2de9a0f0a7db55a8f9a4b8f51013cb3377d9306cd3acf6a992c；component-session.test.ts恢复d7c1de67581a7873493e26973a95ebe69f63c5b8c0be3026d5491bbef9488d5f。候选代码/新增反例归档ignored证据，真实status已恢复原受管路径，局部两组提速不作为保留收益。没有以新full覆盖这项责任变化。独立的祖先链安全修正仍未完成真实验收，不回退到禁止的全局枚举。

### 分级接续后的测试内容静态筛选：未找到可进入轻量验证的合格候选

2026-10-28，按用户继续优化与不得重启的约束，仅回读既有full4日志及最重发布/恢复、workspace发布、真实tarball消费者和相关fixture。未启动新测试、性能实验、安装、build或full，未操作中断Job、旧PID或旧资源；旧一槽仍未归还、Job仍unknown。仅追加本记录，没有生产实现改动，不以本段文档输入变化刷新或伪造full收据。

full4中release的文件累计worker工作为：managed-release342.997秒（5例）、retirement151.485秒（13例）、release130.023秒（31例）、recovery-worker121.759秒（2例）、recovery108.263秒（22例）、resume99.632秒（3例）、push-resume99.504秒（1例）、process68.757秒（15例）、state-transaction66.111秒（6例）。这些数字不能直接相加当full墙钟。完整发布/verify216.810秒只安装/发布一次，verify不再install/push；独立check76.799秒另验证check命令环境、独立checkout及无远端副作用。故障worker各一次真实发布后recover；push-resume的第二次publish检验新鲜观察、不重推dev和只补main；resume两种归档入口已停在安装前，失败安装例的真实两次pnpm是目标行为。进程与事务矩阵保留各自真实身份、锁和故障时点，不复用关闭凭证或可变slot。

通用managed fixture只有少量固定文件、两个提交和独立bare remote，没有明显可缩减的大型非目标数据。workspace release的纯配置校验例确实过度准备真实Git，但仅减少一例准备，未有影响总关键路径的证据，故不为该小项启动实验，也不重做已排除的Git/pnpm、status、退役或祖先宿主方案。安装前置、普通Git组件与预算fixture的既有拆分已经生效，不能把这些已实现收益再次计算。

最新完整pack阶段234.67秒；其中真实release tarball consumer Job为179.482秒（不是早期231秒）。alpha验证真实Node子进程、CRLF、完整managed check与已退出协调器的旧证据拒绝；beta验证真实Node安装失败后CLI同slot恢复、失败回执、junction/锁文件与冻结环境。二者是独立输入根，已避免Node/CLI成功与恢复的笛卡尔积。输入也很小；没有可去除的大数据或多余完整安装。源码与tarball之间确有冷启动契约重复，但两者目前分别承担源码覆盖和已安装包/入口证明。把其中一次迁入同时映射源码coverage的真实tarball验收属于重新分配完整矩阵责任，需要新的等价证明，不能直接删源码成功例或消费者。

full4为1298.0883491秒，release coverage Job778.1504728秒；按该次trace其余成本不变的预算模型，即使release全部归零（不允许实施），其余仍519.9378763秒，超过五分钟。其余主要为pack234.67秒、scripts98.90秒、release之外coverage约152.74秒及lint/types/cycles。该模型不是对所有未来实现的物理下界，但说明单个发布fixture微优化不足以解释五分钟目标。当前审查范围内没有保持原路径、断言及安全观察点且能显著减少真实总工作量的新候选，因此未消耗获准的一次轻量验证。后续若坚持当前完整矩阵，应转向实际执行机制成本的独立归因；若允许合并源码与tarball重复冷启动证明，须先明确覆盖归属、两独立消费者及原断言如何保留，不以更换统计口径算提速。

### 非release分页夹具候选：首次隔离基线被Inspector权限拒绝，停止且无性能结论

后续静态读取pack分段证据：metadata0.50、统一build11.37、tarball与浏览器边界6.51、clean consumer210.28、缓存复制0.02秒，其余约5.99秒未单独分段。consumer安装20.77秒，imports21.60与smokes189.50重叠。27包无prepack/prepare重建，统一构建一次、消费者安装一次，未发现每包重建依赖的证据。

在repository-context的response-pagination.test.ts找到共用大fixture：8例默认各45个src文件，含40叶及两份巨大文本。静态候选按目标配置叶数量及ASCII/Unicode文本；保留11例、原断言、11次真实build、40叶高入度、两个巨大文本及两个16叶真实非空cursor。src累计生成数量模型402→140，未当实测收益。独立审查确认原57行expect保留、额外6条cursor成功/非空断言、跨代例原状。当前候选仅存ignored预览，正式测试文件未修改。

baseline session61839，2026-10-28T01:42:07.8926534Z–01:42:19.0837905Z，11.1902993秒exit1。新driver整体受匿名Job控制，authorize前已持久化scope/root/observer身份和临时根。为避免原helper固定.tmp/tests导致共享写入，两轮计划按相同布局复制冻结源码及原测试到新Job根，依赖只读；所有副本核对冻结SHA，Vite缓存和局部报告仅写新私有路径。1040项清单SHA256=d6935a223f9a6fbb47b6ba1416dd3df3674ff0447739848f10b5d2cde12a441e。

V8coverage在setup/import/tests之前调用node:inspector Session.connect，遭Node权限模型ERR_ACCESS_DENIED / Inspector / Connect。实际0测试、1 unhandled run error，原11例及11build均NOT RUN；该11.19秒不是性能基线。后续未增Inspector许可、未移除权限模型、未换coverage或重试。当前缺少的范围是该测试worker内V8 Profiler连接能力；不得把必要性推断自动扩为已获授权。候选/新full均NOT RUN。

本次失败Job9af72cb9-7596-4fe6-817f-fed66f18d599为closed/normal/empty，租约1/1归零、实际worker峰1、remaining空；新临时根r-cwrixi实际不存在，两个新cache根经身份核验回收。正式27份coverage、dist及旧full收据不变；运行时permissionGuard未执行，不称其已通过。旧unknown Job和空目录未操作，旧一槽保留。详情.tmp/pagination-paired-20261028/handoff.md、baseline/result.json、candidate.patch；保留失败证据，未提交、推送或重启。此段记录在失败终态审计之后追加，不伪称旧full收据覆盖新的文档输入。

### 分页夹具按目标缩减：同文件局部通过，完整收益未验收

Node24.11.1没有单独的allow-inspector许可；用户明确批准仅baseline/candidate各一个测试worker取消新增Node权限模型，driver/CLI约束保留。首次调整后session71366在导入时缺快照包级依赖，0测试、exit1，10.088877秒不计基线；Job清空、私有临时根和缓存均实际清理。定位后将裸依赖按原包importer交回同一Vite resolver，保留公开exports，绑定真实路径/冻结SHA，不安装构建或替换实现。准备阶段先逐目录拒绝junction等重解析路径；独立审查通过后再冻结运行。6个传递工作区依赖dist及TypeScript6.0.3均只读冻结。

有效baseline session62151，2026-10-28T02:26:23.1829958Z–02:26:42.5975956Z，19.4133218秒exit0；candidate12911，02:27:38.7125636Z–02:27:54.5612916Z，15.847288秒exit0。两轮均11PASS、11次真实fixture build，1worker、原150+10及5秒单例上限不增。命令本身16.5725917→13.4946274秒。累计实际generation.files为402→140，巨大ASCII/Unicode文本各8→1；40叶关系分页、两个巨大文本、两个16叶非空cursor、跨代两次build和原57条断言语义保留，新增6条目标触发断言。

36个生产源文件的V8映射相同，statement/function/branch命中分别1418/1883、319/402、943/1580，命中集合丢失0、新增0。1604项冻结域仅测试文件变化：baseline清单a88b412fe4e3127028284ac719ee3abb5df765e2dd16fbfeff10f254cb2cd15d、candidate清单d5c05125eb6fe81d801071c75b0b61fe2d833f14a1324995ce43e23c79effe21；测试SHA e7fc236df80f1a839e4574a715d84448c49833f0872f171f01707ae926c9373c→4a2a1b872c848c35d27bb60274157463ae8b2007347d46aa8b0afd71ae3413fe。正式测试自包含，不依赖ignored实验脚本。

worker-runtime即时证明权限模型关闭、NODE_OPTIONS为空、Inspector监听地址为空；driver/CLI权限模型保持且正式coverage写权限false。worker白名单确实撤销，不能以父级限制声称worker仍限写；私有路径经过审查，正式27份coverage、27包dist、fullreceipt的前后摘要均不变。两Job closed/normal/empty、租约1/1归零、峰1、remaining空；r-JrOLk3/r-WKXrKQ和各自cache/node_modules实际不存在。工具require_escalated，窗口外观未观察。旧unknown Job及一槽预约未动，不能由新Job空推断历史清空。

保留该测试内容缩减，但3.5660338秒（该文件阶段18.369%）只是一对局部观测，旧占用unknown，不外推完整净收益或包装为实质full提速。本轮full/quick/其他文件/lint/types未运行；完整成绩仍1298.0883491秒，五分钟未达。技能记录在验收后追加，旧fullreceipt不覆盖最终输入；未伪造收据或提交推送。详细证据.tmp/pagination-resolved-paired-20261028/handoff.md、comparison.json及两阶段result.json。历史EPERM/SSE/descendants根因仍未确认。

### 代表链瓶颈采样：同 coverage 权限与观测边界未满足，启动前停止

2026-10-28，用户授权一次 managed-release 的真实独立 checkout/check 用例，1 worker、150秒执行加10秒收尾，仅作归因。独立静态复核后未启动：本机 Node24.11.1 下，原 V8 coverage 的 inspector.Session.connect 在新增 Node permission 中已有真实 Inspector/Connect 拒绝证据；分页两个 worker 的例外不外推，不重复拒绝、不自行改普通模式或取消权限。本次没有新 session、Job、run claim、安装、插桩或测试结果，也没有本次工具拒绝或不确定运行。

fixture/Git/slot 可归入新 Job 根；pnpm 还需独立 store/cache/state、PNPM_HOME、XDG 配置、TEMP/Node compile cache，并处理继承的配置/hooks/缓存变量，仅设 store 不足。该隔离设计尚未实际验收。scope-host 的 direct-exit 是 child close 与输出排空后的合并事件，父侧不能据此分别报告 payload exit 和排空耗时。正式 dist/coverage/receipt、断言和实现未改，没有待恢复插桩；旧 Job UNKNOWN 和一槽预约保留。精确缺项、已有拒绝路径和代码哈希见 `.tmp/bottleneck-sample-20261028/preflight.md`；本段只是启动前记录，不是新的性能或清理通过证据。

### 获准单 worker 后的一次采样：CLI 父级元数据拒绝，代表链未执行

用户随后批准仅本次代表worker取消新增Node权限模型，observer/driver/CLI原边界保留，并明确payload至排空只报告合并区间。独立静态复核完成后唯一启动session73898，2026-10-28T04:29:46.0889382Z–04:29:48.4594536Z，2.3694886秒exit1。Vitest CLI解析coverage-v8时，getPackageScopeConfig上探E:\source\ai\package.json，遭Node ERR_ACCESS_DENIED/FileSystemRead。不是缺包证明或工具自动审批拒绝；实际0worker、0tests、0install，worker例外和其Inspector即时审计均未执行，没有性能或瓶颈结论。拒绝后未改权限/解析/coverage、未访问该目标或重跑；不得借此前五个coverage fs.cp进程的祖先读取批准外推。

探针仅为私有Vite内存装饰，没有磁盘源码/dist插桩。冻结1222项（995993d5b16c880f03dd25221b57abed91b855cebff8043cd993a87fcc7000e6）含真实Koffi二进制，最终本段追加前无漂移；27coverage/27dist/receipt未变。新Job bf36f81a-90b1-4043-bb08-c5325c58bc48 closed/normal/empty，租约1/1归零、active0，临时根r-NJ6qCS及私有cache/node_modules实际不存在；normal不代表测试成功。旧Job UNKNOWN与一槽保留，无新unknown。详细交接在 `.tmp/bottleneck-sample-20261028/handoff.md`、`final-outcome.json`，保持停止、未提交。后续先明确CLI祖先package元数据的准确访问边界，不能自动逐级扩权或用普通模式替代同coverage采样。

### 单 CLI 例外实现失误：spawn 也传播权限，不只是 fork

用户另行批准本次一个CLI取消新增模型。session92994，2026-10-28T04:48:31.1621337Z–04:48:33.3696175Z，2.2061953秒exit1；仍0worker/0tests/0install，CLI自有边界守卫失败。原因是诊断driver只删除CLI参数，遗漏Node24.11.1的spawn也会将父模型写入NODE_OPTIONS。官方同版本lib/child_process.js的copyPermissionModelFlagsToEnv（516–529）及normalizeSpawnArguments（659–661）确认该路径；当前不是新权限不足。已有CLI即时审计放在守卫后未落盘，不能把静态计划当实际审计。

已仅静态修正CLI为显式--permission --no-permission（前项阻止自动回灌、后项关闭该已获准模型），审计先写再守卫且按实际布尔值记录；driver模型、worker上限及全部原路径不变。独立静态复核通过，尚未实测、不称修好、不再启动样本。原11个执行harness按fe15efbc4e02719cfa208ec54cba5ac3939b8d6008434e5273c1a80306d36cb0清单归档。一次受限Node的process.binding只读源码查询也被模型拒绝，0.190807423秒自然退出，已停止该读取；仅用官方公开源码核实，没有取消该命令模型重试。

新Job a4d33e68-27dd-4978-8921-8a3f04e77e50 closed/normal/empty，租约1/1、active0，r-JAScA2及私有cache/node_modules实际不存在，无新unknown；旧UNKNOWN/旧一槽保留。27coverage/27dist/receipt未变，正式源码/dist无磁盘插桩。详见`.tmp/bottleneck-sample-20261028/cli-approved-handoff.md`和`cli-approved-outcome.json`；旧fullreceipt仍过期，未提交或运行full。

### 代表 check 链取得归因：功能通过，环境隔离审计失败

原授权内修正复验session46203，2026-10-28T04:57:19.2312498Z–04:58:52.2160461Z，92.9848696秒exit1。CLI/worker即时模型false、NODE_OPTIONS/Inspector监听null，driver模型保留；原单例1PASS/0FAIL、83.449664秒，其他4项NOT RUN。37条命令全部阶段完整，176746span/1456event、dropped/pending0；未再自动采样。

同一worker捕获83.449996秒：三段控制/持久化周边50.148345、根身份等待12.955070、payload至排空6.995812、其他受管阶段3.110408、命令外10.240361。34条Git整受管62.457428秒而payload仅2.022092；install整6.508065/payload4.514005，版本整2.153371/payload0.358602，check整2.090771/payload0.101112。Job.initialize37次仅0.041738秒、empty74次0.007123秒，此入口不支持将原生Job初始化或固定收尾等待当主成本。

主要观察是逐条便宜命令外围的验证与持久化放大：154persist、157atomic、78reserved写、235sync（4.348978秒）；439管理查询按最近记录祖先为314atomic+113lifecycle+其余12。atomic累计37.309784秒含guard/扫描/元数据，不能当纯写盘；543身份查询累计37.996591/并集34.102096与Git等重叠。控制区间仅选定叶API的互斥活动窗口：file-only24.444214、Git+身份15.023196、其他组合3.966983、未覆盖6.713952秒；file-only不是磁盘独占因果成本。不能用外层函数span覆盖后仅52.7ms无span来伪称全部已归因。记录器本体0.376292秒仅开销下界，不含ALS/Promise/V8等，没有配对样本，不能外推full收益。

整体仍FAIL：37次IPC start的isolationMatches均false，原记录只保聚合布尔，不能恢复具体字段，不能称误报或共享写入已排除。原用例PASS及Job empty不代替该隔离缺项；不自动再采样或清理共享缓存。新外层Job f7e2147a-0bc8-4489-97d1-fa6c593fffdc及37内部scope均closed/empty，租约1/1、active0，r-6gFjD4及私有cache/node_modules实际不存在；旧UNKNOWN/一槽保留。冻结1222项3c0c7caec00996905d0ac29ab79007d6259cc0a41e034af40aa92bc29ade585f，在本记录追加前无漂移；正式coverage JSON/dist/receipt摘要未变，无磁盘插桩，内存finish及进程结束已消除本次探针。详见`.tmp/bottleneck-sample-20261028/attribution-handoff.md`、`attribution-outcome.json`及原始trace/posthoc；完整基线仍历史1298.0883491秒，未提交或运行full。

### 固定观察批次原型：先补逐字段审计，尚未取得运行隔离或性能结果

用户接受内部五查询批次恢复的粗粒度中断取舍。仅assertCheckoutFrozen五项固定查询；逐项真实Git/owned scope/身份/guard/预算/取消/关闭仍保留，其他命令不扩展。旧设计的四状态文件布局/频次与安全不变量需要区分，不能因测试存在就把实现永久化；也不能把trusted命令误称为安全沙箱。

先新增24字段的纯审计函数和反例，session62764（07:03:54.624–07:03:56.428Z，1.804秒exit1）原stdout显示1项预期模块缺失失败；session72631（07:06:19.925–07:06:21.812Z，1.885秒exit0）1PASS。worker实际Node模型true、私有写权限false；这两个纯Node单元没有使用已耗尽的CLI/worker例外，没有V8性能采样。Windows大小写/冲突与日志无正文的单元PASS不证明payload实际env或pnpm实际store。两新Job均closed/empty、leases归零、临时根/cache/modules实际不存在，正式coverage/dist/fullreceipt摘要未变；旧Job UNKNOWN保留。

真实批次反例已写，release实现及Vitest/配对/full尚未执行；新例外请求待明确批准。取消CLI/worker模型会影响后续Node子进程继承，不能把“最多4组CLI/worker”误述为全部仅8个进程受影响。详细检查点`.tmp/observation-batch-prototype-20261028/handoff.md`；不根据本轮纯单元宣称完整套件提速。

### 固定五查询恢复批次已落盘：安全定向与局部交替对照通过，完整验收未运行

2026-10-28，仍为 dev / `96cd5c8c1b2124de96c112c4b8447ef12210f515` 加历史未提交修改。接手时11份生产快照与实际源码逐项相同；此前没有批次实现。本轮仅新增内部 `managed-observation.ts`，修改快照所列11个生产文件及自包含 `managed-checkout-observation.test.ts`；保留其他既有修改。用户明确批准同一新 Job 的 CLI/worker/scope-host/Node 后代不启用诊断新增文件白名单，driver 原模型保留，observer 原启动配置不变。

当前合法宿主实测账户为 Administrator（SID尾号500，中完整性，管理员组deny-only），与前次记录的 CodexSandboxOffline 不同。未切换账户、改ACL或重装；精确 branding.js 读取77字节成功。这是当前环境准入证据，不是旧访问错误已修复的证明。

仅 `assertCheckoutFrozen` 显式开启固定计划；完整argv/cwd/次序匹配后，每条仍独立 scope、身份、绑定、授权、真实Git、原解析与取消/时限。每条guard/预算与提交前新鲜复核保留。先写批次intent，逐项结果暂存在内存；独立批次停止证明耐久后才归并完整state。无证明保持UNKNOWN；旧terminal不能证明新意图，证明后state rename失败只读恢复停止事实，原操作仍失败。配置写入及应用命令继续identified完整日志。

| 阶段 | session / UTC | 结果与资源 |
|---|---|---|
| 有效RED | 93787 / 09:18:23.927–09:18:42.725Z | 18.7974784秒、exit1；实际1 FAIL，预期1份批次而原实现5份，余4项首败未运行；5真实scope正常关闭 |
| 安全GREEN | 92392 / 09:33:16.176–09:34:46.101Z | 89.9231928秒、exit0，11/11；32内部scope，其中1个故意在授权前取消，保留unknown/terminated/empty及原START_CANCELLED分类 |
| 同范围交替对照 | 91791 / 09:36:39.604–09:37:36.557Z | 56.9519107秒、exit0，1个诊断用例包含3组AB/BA/AB，30个真实查询scope及1个pnpm路由scope全部正常关闭 |

三组原协议/批次秒数分别为7.3153052/4.3708448、7.4892157/4.1286543、7.3552716/4.2348762。中位 **7.3552716→4.2348762秒，少3.1203954秒／42.4239%**。每次5份恢复记录→1份，完整state写20→2，独立停止元数据写10→2；真实execute/bind/authorize始终5次，lifecycle guard为15→17。预算间隔及各次时限不变；较快结束自然减少周期采样，不是移除逐查询预算检查。

对照只测同一候选执行器的原逐查询分支与显式批次入口，每组使用同一新source/checkout/session，顺序交替；组内历史会增长，coverage与诊断采集均开启，未观察其他宿主竞争。不是旧SHA、37命令代表链或全仓基线，不能把每批节省乘次数承诺full收益，也不能将历史隔离失败采样当合格基线。

GREEN及对照的真实worker/IPC/host/payload逐字段匹配，pnpm最终解析cache/state/store及带版本的store路径归属通过，trace丢失与pending均0。三个新外层Job均closed/normal/empty，租约1/1归零、active0、remaining=[]、峰1；r-ByJsNY、r-SQjGDf、r-4lbpna和各阶段cache/node_modules实际删除。27包正式coverage、dist及旧full收据摘要不变；旧UNKNOWN Job及一槽预约未触碰。

独立静态审查发现一项P2：迟到查询跨最后await后可能追加到已封印批次。已改为最后await后同步重验活动批次、closing/执行占用及新鲜计划位置，再同步占用；新增受控交错反例通过。该反例未单独观测RED，不冒称逐例RED→GREEN。定向lint零错误零警告、release类型检查通过；类型首检两项搭建错误已最小修正，原错误保留。

**边界/No-Go：** 不接受旧terminal或仅子scope关闭作为批次停止证明；不扩大为任意观察/变更命令、不缓存跨查询安全观察；不把取消改为正常成功、不把纯预期环境当实际pnpm路由。未覆盖证明rename之后、摘要返回之前的所有故障窗口，未做真实协调器崩溃矩阵或其他旧测试全回归。临时对照只作诊断，正式11项不依赖ignored脚本。

累计Vitest **4/4已用完**（含前次0tests依赖启动失败），不再自动启动。`pnpm check`、full、真实tarball、全仓覆盖等价与37命令代表链均NOT RUN；历史完整1298.0883491秒仍只是旧输入成绩，五分钟未达。候选可进入后续扩大验收评估，尚不能称正式整合完成；后续应先补受管进程/terminal/事务/恢复/退役/管理路径专项，再做一次获准的完整检查和真实tarball覆盖核对。未提交、推送、CI、发包或重启。证据入口 `.tmp/observation-batch-prototype-20261028/implementation-handoff.md`、`implementation-outcome.json`、`comparison-summary.json` 及各阶段原始报告。

### 固定五查询批次扩大验收：真实崩溃与专项通过，冻结后执行一次 full

2026-10-28，用户在获知下一步后明确要求按计划继续：真实崩溃窗口、受影响回归通过后再运行一次 `pnpm check:full`。这是新的扩大验收阶段，不恢复上一阶段已耗尽的 run.claim 或覆盖历史结果。沿用 dev/现有工作目录及有效依赖，正式 store 实际绑定 `E:\.pnpm-store\v10`；未重装、迁移、改 OS 权限或启用诊断新增 Node 文件白名单。

组件反例 session58400 实际1PASS/1FAIL，原因是 worker helper 只替换部分查询而误启完整批次，报 `OBSERVATION_INCOMPLETE`；仅测试 helper 显式替换/恢复 `observeCheckout` 后 session15524 为2/2，原8条调用断言保留，status、变更、未知命令及应用命令的受管边界不变。生产实现本阶段未改。构建通过后，新增随仓库维护的真实崩溃 worker 与5项正式测试，session76180 为5/5、66.7033608秒。五窗口分别为首查询后、proof rename 前后、state rename 前后；证明前 UNKNOWN，证明后仅恢复5个子 scope 停止事实，保留原 state、必要 lock、归档及无成功回执/远端不变断言。

专项单 worker 串行验证：process 15、terminal 13、state 12、transaction 6、tracking 6、recovery 22、recovery-worker 2、retirement 7+6，合计89/89；连同组件与崩溃共96/96。每个 Job 保持150秒工作及10秒收尾，无超时、强制停止或新 UNKNOWN；外层 Job 均 normal/empty、租约归零、自有临时根实际删除，正式27份 coverage 及原 full 收据摘要保持不变。独立静态审查本轮四份测试/helper 未发现待修复项；未冒称该审查重新覆盖上一阶段全部生产差异或全仓验收。

用户另明确批准既有 Node 脚本测试等待真实 Vitest 夹具时短时2个新 worker，其余阶段仍1；旧 UNKNOWN Job `3f62f512-ce17-4480-be55-44fb7c170baa` 及其一槽继续保留，预算短时共3槽。全局配置仍1，父 worker 不从统计扣除，结束后逐事件核对只出现 node-test 与 vitest 的获准重叠。

本条为 full 前冻结检查点；不把专项 coverage 当全仓覆盖、不与旧双 worker 1298.0883491秒直接比较，也不外推局部42.4239%或宣称五分钟。正式完整检查的实际终态、真实 tarball/覆盖计数、源码指纹、Job/worker 收尾以 `.tmp/observation-batch-validation-20261028/full/result.json` 和该阶段最终交接为准；失败时停止后续，不自动再跑 full。完整日志/授权计划/审查和专项结果均保留在同一固定目录，未提交、推送、CI、发包或重启。

### 扩大验收首轮 full 失败：旧格式消费者夹具未展开批次，修正后复验受执行策略阻挡

唯一 full session87883，UTC 10:35:35.249–10:40:31.315，296.0688589秒、exit1。lint零错误零警告；metadata、统一build、27包tarball/浏览器边界及全部公开入口真实导入通过。消费者安装167.16秒，release smoke在alpha成功check后的旧格式历史退役断言失败，实际 `SLOT_STATE/OBSERVATION_PLAN`。这是失败后的提前结束，不是五分钟成绩；beta、余下消费者、full类型/循环检查、脚本及全仓coverage均未完成，full收据未更新。

根因是测试在schemaVersion=2中保留了schemaVersion=3批次，并把批次父项改为identified；解析器按原安全约束拒绝。最小修正仅在package-consumer夹具中展开全部真实批次子项，再按原方式构造旧格式中断；scope/身份及全部原退役、state/lock不变、远端断言保留，生产解析器不放宽。full失败是有效反例；最终真实消费者GREEN仍未取得，不能把静态检查代替它。

定向真实tarball准备第一次在私有驱动漏调verifyManifest时失败（browserExports未初始化，安装/消费者0次），3.4305904秒，已保留并修正驱动。随后清理本阶段consumer-work半成品的原生命令被执行器明确以blocked by policy拒绝；停止该清理及依赖的准备/消费者复验，未换路径、工具或会话绕过，也未重跑full。保留目录365文件、1113260字节，只有已生成tarball/解压物；无需操作旧UNKNOWN目录。后续须通过当前配置允许的正常策略处理该精确清理动作，才能恢复依赖步骤。

full及失败准备Job均closed/normal/empty，租约归零、自有Job临时根实际删除，未新增UNKNOWN，历史UNKNOWN/一槽不变。最终五份代码文件定向lint零错误零警告，消费者语法、差异及中文扫描通过；正式27份coverage及旧full收据摘要不变。详细终态、文件清单、停止动作及恢复入口见 `.tmp/observation-batch-validation-20261028/final-handoff.md`。本阶段仍未提交、推送、CI、发包或重启。

### 五分钟目标的测试边界重组：定向通过，整体尚未达标

用户随后明确允许调整测试内容、不要求旧数据兼容及保存，并要求非阻断删除失败不影响性能工作。原 consumer-work 后续只读检查已不存在，未重试被拒绝的删除。旧矩阵真实消费者复验曾以129.968743秒通过；此后开始新的当前协议矩阵，不再把历史完整1298秒或失败full当成同输入对照。

保留现有分支、正式依赖及store、单新worker与owned Job；历史UNKNOWN及一槽不动。新生产批次代码本阶段未改。主要改变是脚本集合共用监督Job而每文件仍独立Node CLI；workspace一次真实V8采集、共享pool、原始Istanbul数据按包归属拆分及原事务发布；发布决策改严格完整argv/transport/时钟组件；session与退役协议直接准备真实文件/锁/当前state，而非重复Git来源准入和完整发布。来源、真实进程、真实Git、原子故障及两个tarball消费者各保留明确验证责任，详见测试README。

截至本记录的有效定向结果：脚本批处理单元3/3；workspace配置/分包单元通过，两个真实包43项覆盖及报告发布通过5.941106秒；session/process/terminal30/30通过56.8072379秒；发布组件37项与真实协调器旧10项组合47/47通过38.503051秒，补充协调器失败回执/锁断言后，与真实推送丢响应恢复合计12/12通过87.9062876秒；managed-release5项与组件37项42/42通过75.7480536秒；recovery22/22通过81.2022244秒；resume3/3通过65.6533424秒；当前退役12/12通过33.1655482秒。退役首次5PASS/1FAIL因严格Git脚本漏列反向祖先查询，补完整输入后GREEN，未放宽断言。各外层Job正常empty、租约归零，自有Job临时根已移除。

消费者安装配置由hoisted/copy改isolated/auto，沿用pnpm10.33.2真实tarball、overrides、build policy与store；配置回归先观察旧实现失败再通过。空临时目录实际打包/安装全部27包通过，`.modules.yaml`确认为isolated，安装阶段36.11秒，整个外层63.7479443秒含收尾；这不是与167秒历史安装的严格配对。新tarball矩阵保留alpha Node/CRLF与beta CLI/junction两个独立完整成功入口，失败安装/同槽重试归属已通过的managed-resume；当前真实消费者含安装/导入/断言/收尾113.5656086秒通过。旧schema2降级退役场景移出消费者。

独立复核发现全局VITEST_MAX_WORKERS会覆盖每包限额，已补有效RED→GREEN并在workspace配置解析前消除该覆盖，保留FORGE总预算/共享pool；配置单元3/3通过。协调器回执断言仅比较稳定语义，避免两次finishedAt的时间竞态。复核另记录既有构建前普通CLI的取消需等当前CLI退出；本阶段没有引入新的bootstrap监督架构，受管验收仍由外层Job保证回收，不能宣称独立CLI已有即时树取消。

边界：26个非release包的workspace定向试跑在150秒截止，未通过；53脚本文件虽输出全部功能成功，整体资源审计因node-test/node-test与node-test/consumer嵌套超出已批准Node/Vitest类型而失败，不能记成通过，扩展同一短时两worker上限的问题仍待用户答复。未复跑当前完整pnpm check/full，五分钟目标未达到。两包canonical coverage已按发布实验更新，其余25份及旧full收据未改；现有收据不绑定当前全仓候选。证据均在 `.tmp/observation-batch-validation-20261028/`；未提交、推送、CI、发布或重启。

### 固定批次协议矩阵分层：保留真实代表与全部崩溃窗口

2026-10-28 后续目标续接仍有独立可推进项：将固定批次11项中8项纯协议故障矩阵迁到显式CommandRunner边界，保留真实文件/路径身份/锁/state/rename；合成scope/identity/closure仅为组件输入，不能当真实OS停止。原文件保留5条真实查询scope关闭、查询间源索引被跟踪和批次外config/应用命令三项；五个真实协调器崩溃窗口全部未改。生产实现及tarball输入未改，旧崩溃证据仍有效。

新增helper严格匹配完整command/argv/cwd、只允许manual scope、未知/乱序/直接run拒绝；异步readiness后仍须授权，授权前无输出/完成，取消和显式timeout仅模拟停止输入。合成PID超出OS范围且不进入真实reader；恢复组件显式提供absentReader。4项helper反例及8项协议断言先对明确不可用类型桩观察1FAIL（其余首败停止），这是新helper搭建RED，不是既有业务故障；实现后12/12通过12.3298666秒，原11项当时仍保留。随后才删除原文件中已迁移的8项，新的3+8+4共15/15通过36.5772962秒；原11项89.9231928秒不是同输入配对，不据此承诺全仓收益。

两个GREEN外层Job均normal/empty、租约归零、自有临时根实际删除；canonical27份coverage及旧full收据未改。独立静态复核未发现新增阻断问题，确认合成身份不流入真实PID/终止操作、取消不被exit覆盖、observer错误不吞掉及原有效协议断言迁移完整；复核未运行测试。完整新矩阵仍待此前worker嵌套例外答复，五分钟目标仍未达；未提交或扩大正常并发。

### 当前矩阵full通过与推送阶段夹具重组：局部有进展，整体五分钟未达

用户明确批准既有Node/Node、Node/consumer与此前Node/Vitest同样短时两个新worker，常规仍一个，旧UNKNOWN一槽不动。当前矩阵`full-current-matrix`于2026-10-28 UTC 13:00:18.864–13:24:39.201完整通过，外层1460.3368442秒、内部1456.47秒；27包真实tarball/公共入口/消费者/浏览器边界、类型和循环检查通过，lint零错误零警告，55脚本文件，195个覆盖测试文件1456PASS/3个平台SKIP。26内部Job与外层Job全部normal/empty、active0，自有临时根实际移除；仅三种获准重叠。生成有效full收据的原样副本和精确输入指纹见`.tmp/observation-batch-validation-20261028/full-current-matrix/handoff.md`。历史1298秒是不同输入和并发，不能作配对结论。

实测覆盖率1159.48秒，覆盖率之外已用296.99秒，单独减少启动/报告几秒不可能达标。release-vercel44文件执行876.478秒；最重的recovery-worker两项98.514秒与push-resume一项96.208秒促使下一阶段收窄重复的发布准备。新增随仓库维护的`managed-push-phase-worker.mjs`只准备三种失败阶段：真实main拒绝、真实main已接受后杀协调器、真实dev已接受后丢响应。首次来源准入、独立checkout、原始锁/真实原子状态、每次push的身份/scope/停止凭证都保留；阶段receipt明确ok:false，不声明完整安装或发布成功。公开recover仍真实执行，新增零push及UNKNOWN原state/lock字节不变断言；丢响应后的第二次仍公开publish，保留历史pendingPush、原停止凭证和全部push尝试计数。

为避免阶段receipt代替公开协调器失败接线，当时将managed-release双ref代表链改为真实验收命令打印原冻结环境后exit17，检查真实失败effects/receipt/归档/锁释放/verify建议，再在源码配置改变后经公开verify执行原冻结命令。原publish环境、真实双push和冻结verify断言保留；两个tarball和五个真实批次crash窗口未改。此处原先把tarball称作完整成功发布链，后续核源码确认错误：两者都只执行managed check。因此该失败代表不能替代唯一的原生发布成功代表，下一条记录已恢复真实发布成功并补独立失败报告组件。生产实现、status白名单与并发配置未改。

新worker的明确未实现桩令实际测试1FAIL（另1项未选），8.2677373秒，是新fixture能力RED，不是生产缺陷RED。两项workers GREEN47.3419733秒；三项矩阵GREEN80.2980752秒；强化耐久intent/原state后，与公开失败代表合计4PASS、113.8572784秒，三项推送恢复文件执行合计71.325秒。旧full194.722秒与定向采集不是严格配对；同一单项补验41.680秒显示明显波动，不能外推稳定净节省或整体成绩。公开失败新增断言首次错误要求CLI命令带SHA，核对实际契约后改为回执candidateSha和冻结verify；未放宽生产。lint首检仅因缺显式node:process导入报6处no-undef，修正后最终零错误零警告16.0118967秒、27包类型12.9876466秒；最后全部push尝试计数单项GREEN43.1526022秒。所有完成Job均normal/empty、active0、临时根移除，未产生新的宿主UNKNOWN。

独立只读静态复核无阻断，未跑测试；推送计数由成功返回后采样改为透明spy的全部尝试，避免漏掉失败重推。新矩阵full尚未复跑，旧full收据保持原样但不代表变更后的候选；本条及详细ignored交接均在验收后更新，不手工追改收据。五分钟目标保持未完成；不立即再跑二十多分钟全量，先继续重组其余恢复协议矩阵的重复准入/准备。详细证据见`.tmp/observation-batch-validation-20261028/push-phase-handoff.md`，未提交、推送、CI、发包或重启。

### 更正消费者覆盖映射，恢复发布成功代表并重组恢复协议矩阵

2026-10-28续接直接推进上述测试边界重组。核对源码纠正上一条tarball发布成功误报：恢复managed-release双真实ref发布ok:true和冻结verify；新增managed-publication-report，以显式来源/checkout/发布引擎组件输入经过生产协调器，验证unknown effects、失败receipt、归档、恢复建议和真实锁释放，空命令集合不冒充OS停止。两项定向GREEN60.7010748秒。生产固定五查询批次与五个真实崩溃窗口未改。

真实tarball消费者保留两个独立仓库，alpha承担完整Node managed check及CRLF+junction，再由实装CLI recover核对原state不变与零安装/检查；beta承担CLI workspace成功，再提交managed配置验证外来slot在安装/检查前拒绝。首轮84.7822761秒失败：beta未跟踪user-note触发正确的GIT_DIRTY；仅把beta辅助文件明确写入其.gitignore，保留alpha未跟踪用例，不改生产脏树规则。空目录重新打包5包依赖闭包、真实安装/公开导入/消费者GREEN83.1608051秒，smoke56.43秒。旧5包定向113.5656086秒及旧full中release consumer95.1640993秒不是严格配对，不把安装波动或阶段差异算成稳定净提速，也不把本次5包冒称全27包验收。

恢复矩阵的11项回执选择、身份判定、缺失checkout、已停止归档和陈旧观察决策迁入managed-recovery-protocol；真实目录、身份、原始锁、当前schema3、原子状态/回执/归档和PID查询保留。Git来源/远端仅是严格组件输入，未知Git及应用命令在执行前拒绝，无合成子进程关闭凭证。先保留旧项新增11项GREEN18.4013544秒，再迁出重复旧项，组合仍22项GREEN62.3519302秒（原生11项47.091秒、协议11项10.393秒）；旧full22项82.692秒不是严格配对。真实来源/remote/anchor/config、Git ancestry、retained-lock worker停止证据和实际refs推进仍在原集成文件。独立静态复核确认关键断言保留，发现Execution.run可穿透后补执行前拒绝和零调用，最终11项GREEN16.2731615秒；评审未跑测试。

最终27包类型GREEN13.0033077秒，lint零错误零警告15.642356秒，git diff --check及UTF-8/中文扫描通过（连续问号仅合法空值合并）。9个已完成外层Job含首败均closed/normal/empty、active0、自有临时根removed；27份canonical coverage及旧full收据均保持原样，历史UNKNOWN一槽未动。完整当前组合NOT RUN，五分钟目标仍未达到；最近全量1460.3368442秒属于旧输入，不能代表本候选。精确输入/首错/结果/恢复位置见`.tmp/observation-batch-validation-20261028/consumer-recovery-handoff.md`。无在途执行，未暂存、提交、推送、CI、发布或重启。

### 状态/锁组件保留，事务守卫候选撤回；发现身份读取的下一成本方向

2026-10-28续接，原state12拆为来源准入7+直接真实存储5；原recovery-lock3保留全部互斥/替换锁/真实子协调器kill及claim接管/state字节断言，仅直接准备协议输入与自有最小Git仓库/空HEAD。首次直接session夹具15PASS被独立静态复核指出会向上查询外层Git；根断言实际1FAIL/2未选4.0292941秒，随后补自有Git根/空HEAD，父/child仍执行真实索引守卫，最终15PASS28.2755906秒。正式测试自包含、不依赖ignored诊断脚本，不假造OS关闭或发布成功。

事务6项4协议守卫+2完整守卫原型11PASS47.5788411秒、组合18PASS70.9948763秒；事务文件41.164/48.014秒，波动覆盖预期收益，No-Go完整撤回worker和test，与旧full输入哈希逐一相同，不保留额外模式。原6项完整守卫和真实rename崩溃证据复用，不用实验原型PASS冒称最终6项重跑。最终保留state7/storage5/lock3文件分别16.030/1.775/6.214秒，旧full25.934/10.174秒非严格配对，不外推整仓净收益。27包类型13.0867633秒、lint0/0为15.7329141秒；生产、消费者与批次真实crash未改。

不继续仅拆小准备：读取现有代码发现每个已知PID的公开身份查询会启动PowerShell，而现有Windows Job实现已用koffi3.3.3/GetProcessTimes。正式owned Job中只交替查询当前自有Node PID8次，严格比较完整身份，不枚举/不改Job/不终止进程，每个只读handle在finally关闭。最终源码/实际dist/脚本/监督驱动完整冻结样本4.1327925秒通过：公开reader总2045.1463ms（单次217.553–295.0098），原生总0.6191ms，初始化7.4193ms，身份8/8完全一致。先前3.8142113秒正例未冻结dist，保留为不完整输入记录，不作最终样本。

探针仅为已知存活自有PID正例，未实施新生产Provider，不能证明ABSENT/拒绝/PID失效或复用/取消/超时/关闭，也不能乘局部比例宣称全仓提速。下一阶段转向显式原生身份读取设计与反例，禁止隐式fallback或扩大进程权限/枚举范围。9个stage含RED均closed/normal/empty、active0、临时根removed，canonical与旧full收据不变，历史UNKNOWN一槽未动；当前全量NOT RUN，五分钟仍未达到。完整指纹/首错/撤回/结果见`.tmp/observation-batch-validation-20261028/state-storage-lock-handoff.md`。未暂存、提交、推送、CI、发布或重启，无在途执行。
