# @openge/forge-release-vercel

这个包把“检查固定提交、依次推送 Git 分支、复核生产部署”作为明确的 Node 工具提供。它依赖 Node.js >=22.14.0、Git 和已配置好的 Vercel Git integration。根入口只导出契约和错误码，浏览器可安全加载；所有 I/O 都从 `./node` 进入，该入口声明 `browser: null`。

内部 Git 命令用单次调用配置让自动维护和垃圾回收保持在前台，仍受命令时限和受管进程归属检查约束，不改写仓库或宿主 Git 设置。命令退出后若仍有其他后代，继续保留未知关闭状态，不能因随后强制清理为空就升级为正常完成。

## 配置与调用

默认读取工作目录中的 `release.config.json`，完整示例见[包 README](../../../packages/release-vercel/README.md#configuration)。配置必须声明 `schemaVersion: 2`、显式 source、Git remote/期望仓库/开发与发布分支、Vercel team/project/HTTPS 生产源、检查与线上验收命令、构建标记以及有限的执行预算。schema 1 不转换、不回退。未知字段、无效分支、凭据型域名和无限时限都会失败。checks/acceptance 均须有 1–32 项，不通过 shell 执行。Windows 上 pnpm/npm 解析到 JavaScript CLI，不直接启动 `.cmd`。

```sh
pnpm exec forge-vercel-release check
pnpm exec forge-vercel-release login
pnpm exec forge-vercel-release publish
pnpm exec forge-vercel-release status
pnpm exec forge-vercel-release verify --sha <完整40位SHA>
pnpm exec forge-vercel-release recover
```

参数支持 `--cwd DIR`、`--config FILE`；`--sha SHA` 仅适用于 status/verify。stdout 是 JSON，成功退出 0、运行失败退出 1、参数错误退出 2。项目可映射为 release:check、release、release:status、release:verify。prepare/check/acceptance 接收受保护的 `FORGE_RELEASE_COMMAND=check|publish|verify` 与 `FORGE_RELEASE_SHA`；验收另接收 URL、deployment ID。宿主同名值不能覆盖。这些值只说明操作意图，不授予业务权限；业务断言、幂等远端准备和业务恢复由消费方承担。

## 受管提交模式

source 使用以下配置，其他字段沿用完整示例：

```json
{
  "mode": "managed-commit",
  "slotPath": ".tmp/release-slot",
  "maxBytes": 2147483648,
  "minFreeBytes": 5368709120,
  "sampleIntervalMs": 1000,
  "install": { "packageManager": "pnpm" },
  "prepare": []
}
```

先提交受管槽及 `.tmp/forge-vercel-release/` 的 ignore 规则。slotPath 是仓库内 ASCII 相对路径，不能跳出、含 `.git` 或重叠管理锚点。示例单槽 2 GiB、卷至少 5 GiB 余量；公共包通过配置接收，不绑定盘符。采样间隔 250–5000 毫秒，prepare 允许 0–32 项。

ignore 文件允许 Git checkout 带来的 CRLF/LF 行尾差异，其他字节仍须与冻结提交一致；不执行 clean filter 来掩盖真实改动。全局 ignore 和 `.git/info/exclude` 不能替代已提交规则。工作树中的未提交规则仍被拒绝。

managed-commit 冻结开发分支完整 SHA、已提交配置、精确 `pnpm@<版本>`、锁文件和脚本。源 tracked/index/配置必须干净，无关 untracked 原样保留。真实独立 clone 从远端建立，再从冻结源 fetch 尚未推送的候选对象；安装、prepare、检查与验收均在同一 checkout 执行。安装核对本机 pnpm 版本，使用 frozen-lockfile，不自动下载其他版本。禁止配置对象覆盖，不复制源私有 Git 配置、不创建 worktree、不切源分支、不使用 reset/stash/clean、不迁移共享 store。

同一槽复用依赖，同 SHA 重跑不重建环境；下一 SHA 必须可从干净槽快进。脏槽、分叉、外来目录、junction 根、外部 Git 对象依赖、源码链接、gitlink、LFS 指针或不支持的路径失败，不增加旁路槽。拒绝继承 Git 目录、索引、对象库及 namespace 覆盖；认证、路由、hooks 仍属调用方受信任配置。

status/verify 选择最近 publish 收据，后来源 HEAD、配置或 check 不覆盖选择；指定没有匹配收据的 SHA 拒绝。verify 在受管锁/预算内使用原始 checkout、配置和验收脚本，缺失或不可信时失败，不安装、不回退到当前源脚本。

原工作区模式使用 `"source": {"mode":"workspace"}`，保留包含 untracked 的严格 clean 规则。已有 managed 锚点不能静默改槽、改配置绑定，或切回 workspace 执行检查/发布；先按实际收据、锁及引用完成显式维护，无自动迁移或清场。

## 各命令的边界

check 校验冻结输入并运行检查，不推远程、不查询 Vercel；受管模式包含固定槽准备和冻结安装。下文原根锁路径及 HEAD 回退描述适用于 workspace；managed 使用上节的槽、冻结输入和收据选择。

`publish` 在项目 `.tmp/forge-vercel-release/` 内取得独占锁，冻结候选 SHA。它 fetch 并确认远程开发/发布分支都能快进到该 SHA，查询官方 API 核对项目、仓库绑定、生产分支与认证，再运行检查。检查通过后重新核验来源和候选，每次远程 push 前再核验项目绑定与锁归属，先精确推开发分支，再推固定 SHA 到发布分支。两个 push 都不使用 force，也不切分支、不自动 commit。它等待现有 Git integration 创建的相同 SHA、项目、production 与发布分支部署 READY，然后核对生产 alias 对应的项目和部署，匿名获取构建标记并比对 revision，最后运行消费方验收。

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

runRelease 支持 command、cwd、configPath、workspace 专用 config 对象、sha、signal、transport、onLoginOutput。managed 必须用已提交文件。transport 仅替换 API/buildInfo 外部边界，必须响应取消；onLoginOutput 显示脱敏认证指引。公开签名不携带第三方实现类型。

## 恢复与资源所有权

受管锁覆盖准备、安装、检查、推送、等待和验收。显式装配 Windows x64 Job Object 或 Linux/glibc x64 subreaper/wait/pidfd Provider。runner 的 manual 门先取得 scope-ready，再持久保存真实身份、scopeId 和 run/command/nonce 绑定，复核预算、路径和锁后放行。只有匹配的 OS scope closed/normal/empty 证明允许下一命令或释放锁；取消、身份变化、崩溃缺口、遗留后代及强制清理即使最后 empty=true 也仍 unknown。

旧 schema 2 轮询 closure 可读，但属于弱证据，不能自动升级、复用为成功或依据 PID 消失删锁。旧 command-gate/result 文件不执行、不自动清理；新运行不再创建它们。持久 OS 证据绑定已结束实例，可复用而不重新探测后来复用的 PID。每条记录的 nonce 仅存在受控 journal，不输出到 CLI 报告。

原生依赖 Koffi 精确固定 3.3.3。本仓与 tarball 消费安装禁用其构建脚本，其他 pnpm 消费者也应设置 `allowBuilds.koffi: false`。缺少预编译制品、原生能力或 Job 绑定失败在业务 argv 前拒绝，不下载、不编译、不提权、不回退。归属层不是安全沙箱，受信任命令不得通过 WMI、系统服务等外部所有者代办；workspace 不启用新 scope。

预算统计包含槽内全部条目及原根锚点，hardlink 各条目重复计数，内部链接不遍历，外部或未知链接失败。一次最多观察 500000 项，原子元数据写入检查临时峰值。准入、运行监测和阶段观察遇到超限、余量不足或观测不完整即取消。报告记录观测峰值、最小余量和采样间隔。有限采样不等于 OS 配额，间隔内可能短暂超限；不调整宿主卷或配额、不整理共享 store。

pnpm 安装过程中，受管根内的 symlink 或 Windows junction 可以暂时指向尚未创建的目标。观察器逐段核对已有祖先及根身份，链接解析最多 40 跳，缺失目标时统计链接自身，目标形成后通过普通目录遍历计数；外部目标、祖先逃逸、循环链接和根替换仍拒绝。已具备关闭证明的历史运行可带着这类内部链接通过正式 recover 入口恢复并复用槽。旧运行若未保存 OS 关闭见证，更新工具后仍不能凭 PID 消失解锁，应保留原状态和锁；本修复不伪造正常退出，也不提供清槽绕行。

生命周期包装错误保留 Node 系统错误及底层公开契约已定义的 `causeCode`，后续持久化错误不能覆盖已记录首错，不记录原始异常消息、任意自定义错误码或环境。`PROCESS_LIFECYCLE_FAILED` 的历史记录若没有底层分类，不能仅凭后续测试通过就追认其根因。

槽内 latest-check/latest-publish 分开，状态与单份收据不超过 1 MiB；原根 managed.json 锚点不超过 64 KiB，绑定槽/配置/发布身份。单步 stdout/stderr 各最多 2048 UTF-8 字节并标明截断，effects/关键错误不能截断。写入和释放前核对路径、源 index/HEAD 和锁归属，外来槽、陈旧锁和半写入残留不自动清理。

受管 push 不明时保留 pending/unknown 与运行锁。recover 独占取得恢复声明，核对 owner、进程、真实 refs 与部署身份，不安装、不检查、不验收、不推送、不部署、不回滚。仅在关闭可证明且引用可恢复时落观察并精确释放旧锁：等于候选记 already-current，候选祖先记 not-current（只表示观察时未指向候选，不能声称从未尝试）；已向后推进、分叉或无法核验时保留锁。原发布失败和 unknown 保留，另附时间戳观察；status 结合证据和当前 refs 展示已核实事实。崩溃缺闭环见证时，即使进程后来消失也仍 unknown，无强制确认或自动删锁入口。按 recovery.nextCommand 继续，未消除的身份缺口须维护者调查精确运行。workspace 不支持 recover。

以下原根报告与人工恢复说明仅适用于 workspace 模式：

任何前置失败都会阻止后续副作用；失败后不自动回滚或改历史。push 成功后发生线上失败，报告仍保留已推状态；结果不明的 push 标记 `unknown`，先核对真实 remote。同 SHA 重跑仍执行精确 SHA 的普通 push，由服务器的 porcelain 结果报告 up-to-date；不根据旧 refs 快照跳过目标。它读取既有部署，工具从不调用部署创建/上传 API。

取得锁且确定候选后，最近尝试报告原子写到 `.tmp/forge-vercel-release/latest-publish.json`，包含失败和恢复命令。发布分支已推时建议按固定 SHA 复核；未推或不明时建议重新 publish，并重新 fetch 判断。报告是本地恢复数据，不构成新的发布授权。

锁保存 PID、独占 token 和获取时间，每次 push、落报告和释放前都必须仍属本调用。已有锁不自动抢占，归属变化时保留他人的锁并失败。崩溃或强杀后须人工核对精确锁归属与远程状态，才处理陈旧锁。正常退出、失败、超时和取消释放自己的锁；命令执行器负责子进程生命周期。请求、轮询与输出都有明确上限。认证实时输出按完整行缓冲，跨分块脱敏后按每个流同一字节预算转发，结束时处理最后的未换行尾部。已知凭据格式会脱敏，但配置的命令属于受信任代码，仍不应输出秘密。

## 错误码

完整代码列表从根入口 `releaseErrorCodes` 导出；逐项含义见[错误码表](../../../packages/release-vercel/README.md#error-codes)。配置与参数使用 `ARGUMENT_INVALID`、`CONFIG_INVALID`、`CONFIG_READ`；Git 门禁使用 `GIT_*`、`CANDIDATE_CHANGED`；检查与验收使用 `CHECK_FAILED`、`ACCEPTANCE_FAILED`；生命周期使用 `COMMAND_TIMEOUT`、`COMMAND_FAILED`、`CANCELLED`、`LOCKED`、`LOCK_OWNERSHIP`；Vercel 与域名复核使用 `AUTH_REQUIRED`、`VERCEL_API`、`DEPLOYMENT_*`、`ALIAS_MISMATCH`、`BUILD_INFO`、`BUILD_REVISION`；其他本地错误使用 `IO_FAILED`。

官方 CLI 固定为 64.7.0，只通过 `vercel api` 发 GET 查询并复用官方 session，不私读认证文件。其严格安装需要的 WASM peer 同样固定版本。真实 Git bare/工作仓测试、进程输出/超时/取消测试及 tarball 消费测试共同验证公开行为；受控 Vercel 替身不等于真实生产部署验收。

schema 2 新增来源/收据错误 SOURCE_CHANGED、SOURCE_UNSUPPORTED、RECEIPT_SHA_MISMATCH，槽错误 SLOT_PATH、SLOT_FOREIGN、SLOT_STATE、SLOT_NOT_FAST_FORWARD，额度错误 BUDGET_EXCEEDED、BUDGET_UNKNOWN，以及 PROCESS_STATE_UNKNOWN、RECOVERY_REQUIRED。业务生产复用需由各消费方独立验收，不以合成 fixture 替代。
