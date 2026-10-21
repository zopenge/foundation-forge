# @openge/forge-release-vercel

这个包把“检查固定提交、依次推送 Git 分支、复核生产部署”作为明确的 Node 工具提供。它依赖 Node.js >=22.14.0、Git 和已配置好的 Vercel Git integration。根入口只导出契约和错误码，浏览器可安全加载；所有 I/O 都从 `./node` 进入，该入口声明 `browser: null`。

## 配置与调用

默认读取工作目录中的 `release.config.json`，完整可执行配置示例和每项边界见[包 README](../../../packages/release-vercel/README.md#configuration)。配置必须声明 `schemaVersion: 1`、Git remote/期望仓库/开发与发布分支、Vercel team/project/HTTPS 生产源、检查与线上验收命令、构建标记路径/字段以及有限的命令、请求、部署和输出预算。未知字段、无效分支、重复开发/发布分支、凭据型域名和无限时限都会失败。命令数组均须有 1–32 项，不通过 shell 执行。Windows 上 `pnpm` 和 `npm` 解析到 JavaScript CLI；不直接启动 `.cmd`。

```sh
pnpm exec forge-vercel-release check
pnpm exec forge-vercel-release login
pnpm exec forge-vercel-release publish
pnpm exec forge-vercel-release status
pnpm exec forge-vercel-release verify --sha <完整40位SHA>
```

参数支持 `--cwd DIR`、`--config FILE`；`--sha SHA` 仅适用于 `status` 和 `verify`。stdout 是一个 JSON 报告，成功退出 0、运行失败退出 1、参数错误退出 2。消费仓库应忽略 `.tmp/`。线上验收命令接收 `FORGE_RELEASE_SHA`、`FORGE_RELEASE_URL`、`FORGE_RELEASE_DEPLOYMENT_ID`，产品自己的浏览器或接口断言由这些命令承担。

## 各命令的边界

`check` 校验根目录、remote 和干净开发分支，运行配置的检查，再核对源码、HEAD 与配置未变化。它不推远程，也不查询 Vercel。

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

`runRelease` 支持 `command`、`cwd`、可选 `config`/`configPath`、`sha`、`signal`、`transport`、`onLoginOutput`。显式配置对象优先于文件，并进行严格校验和复制。`transport` 仅替换明确的外部传输边界，提供 `api(path, signal)` 与匿名 `buildInfo(url, signal)`；实现必须响应取消。Node 调用方可用 `onLoginOutput` 显示认证指引。报告保留时间、候选 SHA、配置 SHA-256、有界命令输出、两次 push 各自结果、部署身份与结构化错误。

## 恢复与资源所有权

任何前置失败都会阻止后续副作用；失败后不自动回滚或改历史。push 成功后发生线上失败，报告仍保留已推状态；结果不明的 push 标记 `unknown`，先核对真实 remote。同 SHA 重跑仍执行精确 SHA 的普通 push，由服务器的 porcelain 结果报告 up-to-date；不根据旧 refs 快照跳过目标。它读取既有部署，工具从不调用部署创建/上传 API。

取得锁且确定候选后，最近尝试报告原子写到 `.tmp/forge-vercel-release/latest-publish.json`，包含失败和恢复命令。发布分支已推时建议按固定 SHA 复核；未推或不明时建议重新 publish，并重新 fetch 判断。报告是本地恢复数据，不构成新的发布授权。

锁保存 PID、独占 token 和获取时间，每次 push、落报告和释放前都必须仍属本调用。已有锁不自动抢占，归属变化时保留他人的锁并失败。崩溃或强杀后须人工核对精确锁归属与远程状态，才处理陈旧锁。正常退出、失败、超时和取消释放自己的锁；命令执行器负责子进程生命周期。请求、轮询与输出都有明确上限。认证实时输出按完整行缓冲，跨分块脱敏后按每个流同一字节预算转发，结束时处理最后的未换行尾部。已知凭据格式会脱敏，但配置的命令属于受信任代码，仍不应输出秘密。

## 错误码

完整代码列表从根入口 `releaseErrorCodes` 导出；逐项含义见[错误码表](../../../packages/release-vercel/README.md#error-codes)。配置与参数使用 `ARGUMENT_INVALID`、`CONFIG_INVALID`、`CONFIG_READ`；Git 门禁使用 `GIT_*`、`CANDIDATE_CHANGED`；检查与验收使用 `CHECK_FAILED`、`ACCEPTANCE_FAILED`；生命周期使用 `COMMAND_TIMEOUT`、`COMMAND_FAILED`、`CANCELLED`、`LOCKED`、`LOCK_OWNERSHIP`；Vercel 与域名复核使用 `AUTH_REQUIRED`、`VERCEL_API`、`DEPLOYMENT_*`、`ALIAS_MISMATCH`、`BUILD_INFO`、`BUILD_REVISION`；其他本地错误使用 `IO_FAILED`。

官方 CLI 固定为 64.7.0，只通过 `vercel api` 发 GET 查询并复用官方 session，不私读认证文件。其严格安装需要的 WASM peer 同样固定版本。真实 Git bare/工作仓测试、进程输出/超时/取消测试及 tarball 消费测试共同验证公开行为；受控 Vercel 替身不等于真实生产部署验收。
