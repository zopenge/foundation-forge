# @openge/forge-release-vercel

发布恢复锚点、workspace 收据和需要保留的 prebuilt 输入使用 `state/forge-vercel-release/`，示例受管槽使用 `state/release-slot/`；过程性临时文件使用 `tmp/`。开始前提交对应 ignore 规则。此次位置切换不自动迁移旧状态，也不查询旧临时根；升级前须用原工具版本在原宿主完成或退役活动运行。原路径和文件身份属于恢复证明，移动活动槽或复制 journal 不能保持该证明。

这个包提供固定提交的 Git integration 发布，以及显式的预构建制品交付。它依赖 Node.js >=22.14.0 和 Git；默认交付需要已配置的 Vercel Git integration，prebuilt 交付使用既有、未连接 Git 的项目。根入口只导出契约和错误码，浏览器可安全加载；所有 I/O 都从 `./node` 进入，该入口声明 `browser: null`。

内部 Git 命令用单次调用配置让自动维护和垃圾回收保持在前台，仍受命令时限和受管进程归属检查约束，不改写仓库或宿主 Git 设置。命令退出后若仍有其他后代，继续保留未知关闭状态，不能因随后强制清理为空就升级为正常完成。

冻结源码复核和已提交配置读取保留 Git 执行失败、命令超时、取消和进程关闭未知的原始结构化错误，继续阻断发布，不把这些观察失败改报为源码变化或配置未提交。仅在 Git 正常退出并确认配置路径不存在时报告配置未提交；实际源码、索引、分支、远端或配置变化仍返回 `SOURCE_CHANGED`。

受管命令与只读管理检查统一使用最多十秒、且不超过 `commandMs` 的身份观测预算。原有单命令时限同时覆盖观测与执行，不因身份读取而重新计时；身份截止、取消及真实观测失败仍终止命令，不自动重试 Git 或发布。

受管 runner 启动后，同一单命令期限覆盖 scope 启动、身份绑定及之后的放行前排队、守卫、预算观察、日志持久化和执行。runner 启动前的槽准入、意图持久化和首次预算采样保持原有独立门禁，不计入该命令期限；本次不新增全流程计时边界。期限到达后，即使排队步骤随后完成，也不再尝试放行 argv；有精确停止证明时仍报告原始 `COMMAND_TIMEOUT`，不把迟到授权包装为 `JOURNAL_FAILED`。真实日志错误和未证明的关闭仍失败，已有超时配置与所有门禁不变。

受管超时报告的 `error.details.preparation` 提供固定大小的阶段诊断：`authorization` 区分尚未请求、已请求和已收到放行确认；已请求不证明目标脚本已执行。`phaseAtTermination`、`terminationAfterMs` 记录终止请求发生的阶段与墙钟，`elapsedMs` 截止授权确认，或未确认时截止 runner 关闭结果与排队准备工作均已结算，因此可能包含 OS 关闭等待。`scopeReadyQueueMs`、`guardMs`、`journalMs`、`budgetMs`、`authorizationMs` 分别记录相应区间；`budgetQueueMs` 与 `budgetScanMs` 只细分显式放行前预算观察的排队和扫描。队列与日志区间可能重叠，日志还包含自身安全检查和扫描，不能把这些数值直接相加为总耗时。诊断不采集 argv、环境、路径或逐事件日志，也不复用任何安全观察。

Windows 执行要求 Windows x64 和已安装的 Koffi 预编译能力。启动身份观测与终止前复核显式共用 Win32 原生 reader，不回退到 PowerShell 身份查询。workspace 首条命令在原预算内完成有界原生能力预检，预检耗时扣除后才将剩余额度交给命令；能力缺失或失败时不启动该命令。后续命令仍各自新鲜读取目标身份。POSIX 路径和受管 Job/subreaper 的关闭证明门禁不变；未知关闭仍失败，不因强制清空而转为正常完成。

## 配置与调用

默认读取工作目录中的 `release.config.json`，完整示例见[包 README](../../../packages/release-vercel/README.md#configuration)。配置必须声明 `schemaVersion: 2`、显式 source、Git remote/期望仓库/开发与发布分支、Vercel team/project/HTTPS 生产源、检查与线上验收命令、构建标记以及有限的执行预算。schema 1 不转换、不回退。未知字段、无效分支、凭据型域名和无限时限都会失败。checks/acceptance 均须有 1–32 项，不通过 shell 执行。Windows 上 pnpm/npm 解析到 JavaScript CLI，不直接启动 `.cmd`。

```sh
pnpm exec forge-vercel-release check
pnpm exec forge-vercel-release login
pnpm exec forge-vercel-release publish
pnpm exec forge-vercel-release status
pnpm exec forge-vercel-release verify --sha <完整40位SHA>
pnpm exec forge-vercel-release recover
pnpm exec forge-vercel-release retire --run-id <运行UUID>
```

参数支持 `--cwd DIR`、`--config FILE`；`--sha SHA` 仅适用于 status/verify，`--run-id UUID` 与 `--abandon-unstarted` 仅适用于 retire。stdout 是 JSON，成功退出 0、运行失败或封存证据待补退出 1、参数错误退出 2。项目可映射为 release:check、release、release:status、release:verify。prepare/check/acceptance 接收受保护的 `FORGE_RELEASE_COMMAND=check|publish|verify` 与 `FORGE_RELEASE_SHA`；验收另接收 URL、deployment ID。宿主同名值不能覆盖。这些值只说明操作意图，不授予业务权限；业务断言、幂等远端准备和业务恢复由消费方承担。

## 受管提交模式

source 使用以下配置，其他字段沿用完整示例：

```json
{
  "mode": "managed-commit",
  "slotPath": "state/release-slot",
  "maxBytes": 2147483648,
  "minFreeBytes": 5368709120,
  "sampleIntervalMs": 1000,
  "install": { "packageManager": "pnpm" },
  "prepare": []
}
```

先提交受管槽及 `state/forge-vercel-release/` 的 ignore 规则。slotPath 是仓库内 ASCII 相对路径，不能跳出、含 `.git` 或重叠管理锚点。示例单槽 2 GiB、卷至少 5 GiB 余量；公共包通过配置接收，不绑定盘符。采样间隔 250–5000 毫秒，prepare 允许 0–32 项。

ignore 文件允许 Git checkout 带来的 CRLF/LF 行尾差异，其他字节仍须与冻结提交一致；不执行 clean filter 来掩盖真实改动。全局 ignore 和 `.git/info/exclude` 不能替代已提交规则。工作树中的未提交规则仍被拒绝。

managed-commit 冻结开发分支完整 SHA、已提交配置、精确 `pnpm@<版本>`、锁文件和脚本。源 tracked/index/配置必须干净，无关 untracked 原样保留。真实独立 clone 从远端建立，再从冻结源 fetch 尚未推送的候选对象；安装、prepare、检查与验收均在同一 checkout 执行。安装核对本机 pnpm 版本，使用 frozen-lockfile，不自动下载其他版本。禁止配置对象覆盖，不复制源私有 Git 配置、不创建 worktree、不切源分支、不使用 reset/stash/clean、不迁移共享 store。

同一槽复用依赖，同 SHA 重跑不重建环境；下一 SHA 必须可从干净槽快进。脏槽、分叉、外来目录、junction 根、外部 Git 对象依赖、源码链接、gitlink、LFS 指针或不支持的路径失败，不增加旁路槽。拒绝继承 Git 目录、索引、对象库及 namespace 覆盖；认证、路由、hooks 仍属调用方受信任配置。

status/verify 选择最近 publish 收据，后来源 HEAD、配置或 check 不覆盖选择；指定没有匹配收据的 SHA 拒绝。verify 在受管锁/预算内使用原始 checkout、配置和验收脚本，缺失或不可信时失败，不安装、不回退到当前源脚本。

原工作区模式使用 `"source": {"mode":"workspace"}`，保留包含 untracked 的严格 clean 规则。已有 managed 锚点不能静默改槽、改配置绑定，或切回 workspace 执行检查/发布；先按实际收据、锁及引用完成显式维护，无自动迁移或清场。

## 预构建交付

在 schema 2 配置中显式增加 `delivery: { mode: "prebuilt", maxFiles: 10000, maxBytes: 268435456, concurrencyControl: { mode: "external-serialization", scope: "production-project" }, admission: [...] }`，来源必须为 `managed-commit`。admission 使用普通 ReleaseCheck 结构且至少一项，由消费者校验账号套餐、剩余额度及制品内容。未声明 delivery 时，旧配置规范化结果、摘要和 Git 发布语义保持不变。每仓可继续使用 `pnpm release` 映射到原公开 CLI 的 publish。

已提交 prepare 步骤生成完整、自包含的 `.vercel/output/`，符合 Build Output API version 3。可通过消费者自己声明并固定版本的官方构建工具生成 standalone 产物；原生依赖须匹配 Vercel 的 Linux x64 运行环境。不得以历史任务目录作为输入，Windows 静态 fixture 通过也不代表原生云运行已通过。Git 字段继续冻结真实源码和开发分支，prebuilt 不推送任何分支，也不以 releaseBranch、caller meta 或伪造 gitSource 授权来源。

逐文件及目录的路径、模式、长度、SHA-256 与 commit、配置摘要一起冻结。Build Output 内允许完整闭包中的相对 symlink，包括 pnpm 依赖链接和 `.func` 别名；逐项绑定链接文本、目标类型和解析后的目标。物理文件只复制一次，不展开链接目录；复制后原输出与副本必须同时经由底层文件系统和 Node 默认 realpath 得到相同的可移植目标。两种解析在 Linux 的链接前缀加 `..` 路径上也可能不同，不能只核对原生 API。绝对链接、junction、外逃、断链、链接或目录循环、大小写冲突及解析不一致均拒绝。链接占用既有 maxFiles 数量预算，目标文本的 UTF-8 字节计入 maxBytes，不提高原阈值；Git 源码、槽位根和元数据仍沿用原有链接拒绝。

上传槽只含 Build Output 和明确的 project/team 上下文，拒绝危险路径、Git/常见环境及凭据文件；生成的 `static/.well-known/forge-prebuilt.json` 为保留路径。任意编译文件中嵌入的秘密仍须消费者审查，路径过滤不构成通用秘密证明。复制前预留新增物理用量和卷余量，仍受既有槽位总预算约束。消费者须在封存和上传期间保持产物静止；这些检查不是对抗恶意并发写入的操作系统沙箱。

check 仅构建、检查和冻结本地产物，不访问云。publish 在消费者准入和目标复核后调用固定 CLI 64.7.0 的 `deploy --prebuilt --archive=tgz --prod --skip-domain --no-wait --json`，以官方归档保留相对链接，明确 project/team 且不允许隐式创建项目。保存 CLI 返回的真实 deployment ID，再从公开 API 核验账号、项目、production、CLI 来源和 READY，并真实读回制品标记。验收针对该候选 URL 执行，通过后再做准入及产物复核，最后提升同一 ID 并回读生产 alias、标记和 revision。不会把 Preview 重建称作同制品提升。

固定 CLI 只归档文件和链接，父目录由这些条目物化，不发送独立目录项。无法物化的空目录会明确拒绝，只有工具必定生成 marker 的父目录例外。目录模式用于本地原输出和副本的一致性检查，不承诺云端还原目录权限。部署子进程单独使用零 umask 保留文件及链接归档头模式；父进程不变。CLI 的配置与缓存位于现场生成的私有目录，直接读取标准 `VERCEL_TOKEN` 环境变量，不将凭据放入参数或写入认证文件，也不依赖用户级 CLI 登录。成功或失败后均回收私有目录；失败时保留原创建效果，不因清理失败丢掉已持久保存的候选 ID。运行时自行生成这些资源，不依赖 Codex 或历史临时内容。

仓库回归在受控 loopback API 上运行真实固定版本 CLI，检查上传 tgz 中的链接、文件摘要和模式，移除原输出及上传槽后再真实加载两层 pnpm 依赖及函数别名。Linux 使用真实 umask 022 和系统 tar 解压；Windows 常规场景保持真实 API，另一个明确命名的场景在 CLI 子进程模拟 POSIX umask 查询/设置。Windows 系统 tar 无法使用非提权链接标志时，由测试内 Node 还原已核对的条目。真实 tarball 的公开 SDK 和 CLI 也覆盖移动后的独立布局。此证据属于本地协议和消费者验收，不代表真实 Vercel 云端或任意原生模块已经运行通过。

默认 prebuilt 写入通过正常受保护配置提供 `VERCEL_TOKEN`；不依赖 Codex 或临时认证脚本。固定 CLI 的 promote/api POST 内部有重试，因此提升使用相同官方公开 endpoint 的单次 HTTPS 请求，受超时、输出和连接关闭约束，不修改或深引 CLI 实现。自定义 transport 的 promote 也必须只写一次并响应取消。

项目 rootDirectory 必须未设置、为空或为 `.`；独立上传根只有 `.vercel`，因此嵌套根配置在记录创建意图之前拒绝，避免一个可提前识别的配置错误留下无 ID 的未知创建。POSIX 上传副本显式恢复记录的文件模式，不依赖调用方 umask。

准入接收 `FORGE_RELEASE_PHASE=create|promote`、候选 SHA、产物摘要、team/project 和 `FORGE_RELEASE_SERIALIZATION_SCOPE`，候选存在时附带 deployment ID。同一项目跨机器、跨仓库的全部写入必须由外部协调者串行化，scope 只是显式声明，不是分布式锁；未知云效果未核清时仍须持有协调约束，不能因本地关闭而放行其他写入。固定槽锁独立保护本地资源。额度不足以 `ADMISSION_FAILED` 停止，消费者可排队或暂停。Foundation 不购买、自动升级或替消费者保证免费额度，不拥有签名注册、实例切换和 Worker 调度。

报告独立保存 prebuilt 绑定及创建/提升效果。两次云写入前均先原子保存 unknown 意图；取消、超时或丢失响应不得自动重发。已记录的同一候选可以显式续验；创建未知且没有 ID 时，不从可自填 metadata 猜测成功。提升未知通过原 ID、平台 promotion job 的完成状态、实际 alias 与标记观察；后续写入前持久保存引用原意图的观察证明。相同提升任务的权威终态失败也可单独记录为 failed，允许之后发布新候选，原首错、unknown 和未验证结果不改写；pending、任务缺失或其他目标不能建立该证明。不会自动回滚。Rolling Release 项目暂不支持。本地关闭与远端效果分别记录，历史首错及 unknown 不因新运行而丢失。

### 可选的构建前版本入口

在既有 delivery 内显式增加 `versionAlias: { hostnameTemplate: "site-{sha}.vercel.app" }`。模板只允许一个完整 40 位小写 SHA 占位符，前缀为 1–22 位小写 ASCII 字母、数字或中间连字符，固定 `.vercel.app` 后缀；拒绝协议、路径、端口、其他域及与生产主机名重合。省略时保持原有行为。prepare/check 在构建前收到受保护的 `FORGE_RELEASE_VERSION_URL`、`FORGE_RELEASE_CONFIG_SHA256`，候选尚未生成时 `FORGE_RELEASE_CANDIDATE_CONTEXT` 为空；不依赖历史临时产物或 Codex 环境。

创建前先查询版本主机名是否占用；暂存并确认 READY 后再次查询。已直接绑定同一项目及部署 ID 时只读核验；否则先保存独立 alias unknown 意图，再至多提交一次绑定。只有明确 404 表示不存在，认证、其他请求错误、间接路由和归属不明均不能当作空位。不同绑定报 `VERSION_ALIAS_CONFLICT`，不主动换绑、不删除补建。版本 URL 的公开标记和 revision 必须匹配原 source/config/artifact，之后才执行验收；提升前后再次核验，并始终提升同一 ID。准入增加 `FORGE_RELEASE_PHASE=version-alias`，验收的 `FORGE_RELEASE_URL` 指向版本入口。

候选生成后的 `report.candidateContext` 及受保护 JSON 环境变量 `FORGE_RELEASE_CANDIDATE_CONTEXT` 公开只读身份：teamId、projectId、sourceSha、configSha256、artifactSha256、deploymentId、candidateUrl、versionUrl、versionAliasVerified。仅包含明确字段，不含凭据、完整配置或环境；消费者的注册与内容验收须使用已核验的版本入口。此上下文不替代业务授权。

`prebuilt.versionAlias` 保存主机名、effect 和 verified，`effects.versionAliasAssign` 与创建、提升独立。取消、超时或丢失响应后，publish 不重放未决绑定；status 只观察，verify 使用原 checkout/配置观察并验收，均不绑定、不提升。别名不存在继续保留未知，包括意图保存后、POST 前中断。后续云写入前必须另存绑定原 hostname/source/config/artifact/ID 的观察证明；原 unknown 历史不改写。本地 recover 仍不要求 Vercel 认证。默认别名读写使用标准受保护 `VERCEL_TOKEN`，其他原有读取沿用官方 CLI 会话。

官方 alias assignment 能移动已有名字，未提供原子 create-if-absent。因此全部写入方仍须共享外部串行协调，覆盖版本绑定、验收、提升和未决核验；读取后写入不能防止不遵守协调的外部并发换绑。响应报告其他 oldDeploymentId 时停止并保留未知，不补偿回滚。消费者负责额度、历史部署保留、当前引用及回滚策略；本能力不无限保留历史，也不把版本入口注册为项目生产域。

## 各命令的边界

下列推送和 Git 来源规则适用于默认 Git 交付；prebuilt 按上一节暂存、验收和提升同一候选，status/verify 只观察原候选、不产生云写入。

check 校验冻结输入并运行检查，不推远程、不查询 Vercel；受管模式包含固定槽准备和冻结安装。下文原根锁路径及 HEAD 回退描述适用于 workspace；managed 使用上节的槽、冻结输入和收据选择。

`publish` 在项目 `state/forge-vercel-release/` 内取得独占锁，冻结候选 SHA。它 fetch 并确认远程开发/发布分支都能快进到该 SHA，查询官方 API 核对项目、仓库绑定、生产分支与认证，再运行检查。检查通过后重新核验来源和候选，每次远程 push 前再核验项目绑定与锁归属，先精确推开发分支，再推固定 SHA 到发布分支。两个 push 都不使用 force，也不切分支、不自动 commit。它等待现有 Git integration 创建的相同 SHA、项目、production 与发布分支部署 READY，然后核对生产 alias 对应的项目和部署，匿名获取构建标记并比对 revision，最后运行消费方验收。

仓库门禁核验 Git 声明的 remote URL 和显式 push URL；它不替代对本地 Git 传输路由、`url.*.insteadOf`、凭据与 hooks 的信任。本地路径/file URL 保留真实 `.git` 目录名，网络标识保留非默认端口。项目 `link` 必须匹配配置仓库与生产分支；详情查询显式传 `withGitRepoInfo=true`，只用权威 `gitSource` 的 provider、仓库 ID、SHA、ref 判定来源。GitHub custom-host 还必须绑定 link 与 source 规范化后的 host/port，跨主机同 ID 仍拒绝。`source` 指标与可自填 `meta` 不提供来源授权，列表 metadata 只辅助定位待核验详情。目前支持 GitHub（含 limited/custom-host）、GitLab 与 Bitbucket，权威字段缺失或 provider 不支持时失败。

`status` 读取指定 SHA 的部署；未指定时优先读取最近 publish 报告锁定的 SHA，仅没有报告时读取本地 HEAD。这样开发分支后续的文档提交不会被当成已发布版本。配置摘要与报告不一致时要求显式传 SHA。status 成功表示查询成功，仍应读取报告中的部署状态。

`verify` 独立查询项目与部署，要求 READY、正确 Git 来源、目标、分支和 SHA，再执行 alias、匿名构建标记和产品验收。它不推远程。`login` 不要求 release 配置，明确委托固定版本官方 CLI，由用户完成一次认证；上限十分钟，CLI 在 stderr 显示认证指引。其余命令不会自动进入认证。

## Node API

```ts
import { runRelease, validateReleaseConfig } from '@openge/forge-release-vercel/node';

const report = await runRelease({
  command: 'verify',
  cwd: repositoryRoot,
  config: validateReleaseConfig(configurationValue),
  sha: candidateSha,
  signal: abortController.signal,
});
```

runRelease 支持 command、cwd、configPath、workspace 专用 config 对象、sha、signal、transport、onLoginOutput，以及 retire 专用 runId、abandonUnstarted。managed 必须用已提交文件。transport 替换 API/buildInfo 及可选的 prebuilt promote 外部边界，必须响应取消、关闭自有资源，且不得重试提升写入；onLoginOutput 显示脱敏认证指引。公开签名不携带第三方实现类型。

## 恢复与资源所有权

受管锁覆盖准备、安装、检查、推送、等待和验收。显式装配 Windows x64 Job Object 或 Linux/glibc x64 subreaper/wait/pidfd Provider。runner 的 manual 门先取得 scope-ready，再持久保存真实身份、scopeId 和 run/command/nonce 绑定，复核预算、路径和锁后放行。只有匹配的 OS scope closed/normal/empty 证明允许同一运行继续下一命令。受控取消或超时可单独证明资源已停止：必须有明确终止请求、Provider 的 terminated/empty 终态，以及精确 scope、binding 和 root identity；命令仍失败或取消，后续新运行重新经过完整门禁。owner-lost、provider-failed、意外遗留后代、身份变化和崩溃缺口不自动升级为安全停止。

新活动状态采用 schema 3，终态回执采用独立 schema 1。放行 argv 前从既有额度中保留 1 MiB 元数据空间，单份 terminal.json 上限 256 KiB；校验和、稳定 proof 摘要、宿主及源/槽/owner/anchor/lock/state 文件身份共同绑定停止事实。回执先落盘，再归并普通状态；写入不扫描 checkout payload、不调用 Git。payload 或其 Git 元数据异常仍阻止执行、复用和清理，但不会抹掉已经取得的停止事实。真实元数据替换、磁盘不足或写盘失败继续阻断。新 checkout 不需要历史临时材料或 Codex 环境；恢复旧运行则必须保留原宿主上的原始本地证据。

每次主状态替换前，终态回执先封存旧文件和已 fsync 暂存文件的精确身份及摘要；协调者在 rename 两侧退出均可读取原有停止事实，同字节复制仍被拒绝。恢复先归档原记录，再在排他声明内清理与封印匹配的未提交暂存文件；未知暂存文件继续阻断，原始状态和远端副作用不改写。

运行状态只接受带有原宿主与历史清单绑定的当前 schema 3；旧 schema 2 状态直接拒绝，不自动转换。配置、报告、收据、锚点和独立证明各自沿用当前 schema。无作用域的轮询 closure 不能标记为已关闭命令，旧 command-gate/result 文件按未知槽内容拒绝，不执行或自动清理。持久 OS 证据绑定已结束实例，可复用而不重新探测后来复用的 PID。每条记录的 nonce 仅存在受控 journal，不输出到 CLI 报告。

原生依赖 Koffi 精确固定 3.3.3。本仓与 tarball 消费安装禁用其构建脚本，其他 pnpm 消费者也应设置 `allowBuilds.koffi: false`。缺少预编译制品、原生能力或 Job 绑定失败在业务 argv 前拒绝，不下载、不编译、不提权、不回退。归属层不是安全沙箱，受信任命令不得通过 WMI、系统服务等外部所有者代办；workspace 不启用新 scope。

预算统计包含槽内全部条目及原根锚点，hardlink 各条目重复计数，内部链接不遍历，外部或未知链接失败。一次最多观察 500000 项，原子元数据写入检查临时峰值。准入、运行监测和阶段观察遇到超限、余量不足或观测不完整即取消。报告记录观测峰值、最小余量和采样间隔。有限采样不等于 OS 配额，间隔内可能短暂超限；不调整宿主卷或配额、不整理共享 store。

pnpm 安装过程中，受管根内的 symlink 或 Windows junction 可以暂时指向尚未创建的目标。观察器逐段核对已有祖先及根身份，链接解析最多 40 跳，缺失目标时统计链接自身，目标形成后通过普通目录遍历计数；外部目标、祖先逃逸、循环链接和根替换仍拒绝。已具备关闭证明的历史运行可带着这类内部链接通过正式 recover 入口恢复并复用槽。旧运行若未保存 OS 关闭见证，更新工具后仍不能凭 PID 消失解锁，应保留原状态和锁；本修复不伪造正常退出，也不提供清槽绕行。

生命周期包装错误保留 Node 系统错误及底层公开契约已定义的 `causeCode`，后续持久化错误不能覆盖已记录首错，不记录原始异常消息、任意自定义错误码或环境。`PROCESS_LIFECYCLE_FAILED` 的历史记录若没有底层分类，不能仅凭后续测试通过就追认其根因。

槽内 latest-check/latest-publish 分开，状态与单份收据不超过 1 MiB；原根 managed.json 锚点不超过 64 KiB，绑定槽/配置/发布身份。单步 stdout/stderr 各最多 2048 UTF-8 字节并标明截断，effects/关键错误不能截断。写入和释放前核对路径、源 index/HEAD 和锁归属，外来槽、陈旧锁和半写入残留不自动清理。

执行结果、OS 停止、本地处置和远端副作用分别记录。可靠停止且本地所有权可信时，普通入口或 recover 可先收尾旧运行；失败、取消和 unknown 原文保存在不可变 history/<runId>.json。release-ready 表示具备精确解锁资格，不宣称后续 unlink 已成功；可选 outcome 保存解锁前的执行结果。新状态绑定前代历史的摘要和文件身份，后来的 check 不会覆盖旧远端未决事实，历史缺失或被同内容替换也会拒绝。

recover 不要求 Vercel 登录，不安装、不检查、不验收、不推送、不部署、不回滚。dev 后续提交、分叉或远端不可达不再占住已安全结束的本地资源，但每次新的远端写入前都必须重新只读核验全部历史未决意图。candidate 或 superseded 只说明当前远端事实；before、diverged、unknown 继续阻止远端写入，原 effects 不改写。若响应丢失的旧意图与本次 SHA、仓库、目标分支完全相同，且新鲜观察确认远端已指向候选，则记 already-current 并跳过该次 push，其余推送仍为普通精确 SHA、非 force 操作。身份不明、协调者仍活动或缺少停止见证时继续阻止复用；PID 消失不能补造证明。workspace 不支持 recover。

### 显式中断封存

`retire --run-id <UUID>` 只处理精确受管运行的资源归属，不执行安装、测试、推送、部署或验收，不把旧命令和旧报告改写为成功。`recover` 发现无法补齐的 closure 缺口后给出该入口；`recovery.reportExists` 明确区分文件存在事实与预期保存路径。

运行在任何受管命令放行前保存宿主指纹和开机观察。退役只使用运行原先记录的宿主，缺失或不匹配时直接拒绝；不接受人工来源证言替代宿主记录。封存来源固定为 `recorded-run-host`，原文件字节和身份仍须保持。

命令保存检查点；实际宿主重启后再执行同一 retire 命令。Windows 仅在同一宿主的系统 uptime 比检查点至少下降 60 秒时接受新开机周期，Linux 要求 kernel boot_id 改变；PID 消失、睡眠和墙钟变化都不是该证明。基线过短、重启后等待太久、宿主身份读取失败时继续阻断，不静默刷新基线，不自动重启电脑。Windows 读取 MachineGuid，Linux 读取 machine-id 和 kernel boot-id；报告仅保存宿主摘要。

Windows 原生 mutex / Linux 对原槽目录 fd 的 flock 串行化 recover 和 retire 元数据事务。取得该 OS 锁仅证明之前的元数据事务不再活动，不能替代旧受管命令的结束证明。各协议只能在该锁内续接自身的遗留声明，外来声明仍受保护。封存再次核对源 commit/config、原文件字节与身份；远端观察单独保存，dev 快进、分叉、不可达或 Vercel 未登录均不阻本地封存，下一次远端写入仍受未决门禁约束。

先将带 checksum 的原始 state、现有收据、锁、所有权和锚点封存到同槽 `retired/<runId>.json`，再精确释放旧 run.lock；history 与 retired 单份均最多 8 MiB，全部计入槽预算。历史空间不足时拒绝新运行，不自动删历史。原 state 与既有收据不改写；原子写入中断和释放锁前后中断都可续验。`retirement.status=retired`、退出 0 仅表示资源封存完成，`historicalVerification=unknown` 与原 effects 保留。下一次 publish 仍走完整门禁并复用同槽，不增加新的发布授权；workspace 模式不支持 retire。

以下原根报告与人工恢复说明仅适用于 workspace 模式：

任何前置失败都会阻止后续副作用；失败后不自动回滚或改历史。Git 交付中，push 成功后发生线上失败，报告仍保留已推状态；结果不明的 push 标记 `unknown`，先核对真实 remote。同 SHA 重跑仍执行精确 SHA 的普通 push，由服务器的 porcelain 结果报告 up-to-date；不根据旧 refs 快照跳过目标。Git 交付只读取既有部署，不调用部署创建/上传 API；prebuilt 的显式写入按上节执行。

取得锁且确定候选后，最近尝试报告原子写到 `state/forge-vercel-release/latest-publish.json`，包含失败和恢复命令。发布分支已推时建议按固定 SHA 复核；未推或不明时建议重新 publish，并重新 fetch 判断。报告是本地恢复数据，不构成新的发布授权。

锁保存 PID、独占 token 和获取时间，每次 push、落报告和释放前都必须仍属本调用。已有锁不自动抢占，归属变化时保留他人的锁并失败。崩溃或强杀后须人工核对精确锁归属与远程状态，才处理陈旧锁。正常退出、失败、超时和取消释放自己的锁；命令执行器负责子进程生命周期。请求、轮询与输出都有明确上限。认证实时输出按完整行缓冲，跨分块脱敏后按每个流同一字节预算转发，结束时处理最后的未换行尾部。已知凭据格式会脱敏，但配置的命令属于受信任代码，仍不应输出秘密。

## 发布后的显式完成阶段

managed prebuilt 可声明 `completion: { idempotent: true, jobs: [...] }`，沿用受管 command/args/timeoutMs；1至32项，其他来源或交付模式拒绝。默认不声明时行为及配置摘要不变。任务只在同一deployment的生产promote、精确alias、marker和build-info复核通过后执行；可选版本alias也须通过。completion前再次运行admission，`FORGE_RELEASE_PHASE=completion`，外部串行协调须持续覆盖整个阶段及恢复。

原槽、原锁、原生runner及journal共同监督任务。受保护的 `FORGE_RELEASE_COMPLETION_CONTEXT` 只提供team/project、精确source/config/artifact/deployment、candidateUrl、稳定productionUrl与可选versionUrl；此阶段 `FORGE_RELEASE_URL` 明确为生产origin。不能从父环境伪造目标，不能把该context当业务授权。任务的远端幂等、权限、完成事实与输出脱敏仍归消费者负责。

报告独立记录completion的not-started/running/failed/unknown/completed、尝试、逐job耗时及真实command证据；失败、超时、取消或关闭未知不会回滚已接受的发布效果，也不重复create、alias或promote。pending时保留原checkout、Git元数据、output/upload目录及封存manifest的精确身份；新SHA的check/publish在准备输入前拒绝复用。

先status观察；本地关闭未证明时先按原recover门禁处理。普通verify不重放业务任务；明确 `verify --sha <原40位SHA> --retry-completion`（SDK `retryCompletion: true`）才可在原候选追加下一次尝试，最多32次。续验只读原配置及artifact，不安装、构建、复制或修复marker；原失败/未知尝试、archive和发布收据保持不变。completed由同绑定真实journal及正常关闭证明支撑，重复verify不重跑；完成后才解除输入pin。

若原命令停止只能由现有retire的后续开机门禁证明，续验只消费同run/slot/source/anchor绑定的final封存记录作为停止准入；原UNKNOWN不变，不能由此宣称job成功。未final、错误绑定或缺失封存证据仍拒绝。发布收据缺失时也沿这份原始封存意图选择失败descriptor，不制造成功收据。

若协调器在发布收据提交前退出，只允许从anchor绑定、已封存且证明停止的原意图续验；报告保留 `recovery.reportExists: false`，不补造成功收据。输入、配置、metadata或历史变化继续阻断。新checkout的正常开发/发布不依赖历史临时文件；旧中断事务的恢复仍需要其原始本地证据，不能靠删槽、换目录或当前manifest猜成功。

## 错误码

完整代码列表从根入口 `releaseErrorCodes` 导出；逐项含义见[错误码表](../../../packages/release-vercel/README.md#error-codes)。配置与参数使用 `ARGUMENT_INVALID`、`CONFIG_INVALID`、`CONFIG_READ`；Git 门禁使用 `GIT_*`、`CANDIDATE_CHANGED`；检查与验收使用 `CHECK_FAILED`、`ACCEPTANCE_FAILED`；生命周期使用 `COMMAND_TIMEOUT`、`COMMAND_FAILED`、`CANCELLED`、`LOCKED`、`LOCK_OWNERSHIP`；Vercel 与域名复核使用 `AUTH_REQUIRED`、`VERCEL_API`、`DEPLOYMENT_*`、`ALIAS_MISMATCH`、`BUILD_INFO`、`BUILD_REVISION`；其他本地错误使用 `IO_FAILED`。

官方 CLI 固定为 64.7.0，只通过 `vercel api` 发 GET 查询并复用官方 session，不私读认证文件。其严格安装需要的 WASM peer 同样固定版本。真实 Git bare/工作仓测试、进程输出/超时/取消测试及 tarball 消费测试共同验证公开行为；受控 Vercel 替身不等于真实生产部署验收。

schema 2 新增来源/收据错误 SOURCE_CHANGED、SOURCE_UNSUPPORTED、RECEIPT_SHA_MISMATCH，槽错误 SLOT_PATH、SLOT_FOREIGN、SLOT_STATE、SLOT_NOT_FAST_FORWARD，额度错误 BUDGET_EXCEEDED、BUDGET_UNKNOWN，以及 PROCESS_STATE_UNKNOWN、RECOVERY_REQUIRED。业务生产复用需由各消费方独立验收，不以合成 fixture 替代。
