# 维护者发布手册

Foundation Forge 通过 GitHub Actions 和 npm Trusted Publishing 发布。常规
release candidate 与稳定版本只使用短期 OIDC 身份并生成 npm provenance，
不使用长期 `NPM_TOKEN`。除首次创建 npm package 外，不应在本地直接执行
`npm publish`。

## 仓库配置

- GitHub Actions workflow 权限为 **Read and write**，并允许 Actions 创建和
  审批 pull request。
- GitHub `npm` environment 存在，并应用维护者审批策略。
- 每个公开 package 信任 release policy 指定的 GitHub repository、
  `release.yml` workflow 和 `npm` environment，且具有 publish 权限。
- Release workflow 保留 `contents: write`、`pull-requests: write` 和
  `id-token: write`，且不读取 npm publishing token。

仓库、package、版本、public exports、内部依赖和发布顺序均从 workspace、
manifest 与 Git 元数据推导。只有 workflow、environment、发布分支、npm
trust CLI 版本和轮询时限等不可推导策略保留在 release policy 中。

## 控制台命令

日常操作使用以下根 package 命令，不需要修改 `PATH` 或设置临时 Node 路径：

- `pnpm release:request-next`：检查当前 `main`、复用或派发当前 commit 的
  prerelease workflow、等待结束，并验证 registry、provenance、tag 和真实
  consumer。失败的同 commit workflow 只有传入 `-- --retry` 才会重新派发。
- `pnpm release:dispatch-next`：只完成安全预检和 workflow 派发/复用，适合
  分步排障。
- `pnpm release:status -- --sha <commit>`：读取精确 commit 的 run、jobs 和
  steps；追加 `--logs` 时通过 Git Credential Manager 读取并脱敏筛选失败日志。
- `pnpm release:verify -- --mode next|stable|bootstrap`：独立执行 registry
  验证；可重复传入 `--package <name>` 缩小范围。
- `pnpm release:configure-trusted-publishers`：幂等检查所有公开 package，
  仅配置缺失项；也可重复传入 `--package <name>`。OTP 掩码读取且不会写入
  参数、Git、文件或日志。

`release:next` 和 `release` 是 workflow 内部的实际 publish 命令。维护者从
本地请求 RC 时应使用 `release:request-next`，不要用关闭 provenance 的方式
直接运行内部命令。

## 发布 release candidate

1. 将变更 package 设置为目标 prerelease 版本，并为最终稳定发布保留
   Changeset。
2. 将经过 review 的 commit 合并并推送到 `main`。
3. 在干净、与 `origin/main` 完全一致的本地 `main` 执行：

   ```sh
   pnpm release:request-next
   ```

4. 命令会确认至少存在一个 prerelease、所有 package 已完成 bootstrap、只发布
   registry 缺失的版本，并等待完整验证通过。

同一 commit 的操作是幂等的：排队或运行中的 workflow 会被接管，成功 run 会
直接进入验证，失败 run 不会静默重派。已存在的 package 版本必须已经具有对应
Git tag；工具不会猜测 tag 应指向哪个 commit。

## 发布稳定版本

1. Review Changesets Version PR，确认版本、changelog、内部依赖范围和 package
   集合。
2. 将 Version PR 合并到 `main`。
3. push 触发的 Release workflow 执行 `pnpm release`，把缺失稳定版本发布到
   `latest`，生成 provenance，并通过 Changesets v2 `CHANGESETS_OUTPUT`
   NDJSON 上报新 tag。
4. workflow 结束后运行 `pnpm release:verify -- --mode stable`；验证通过前不迁移
   consumer。

不得手工发布稳定版本，也不得让 prerelease workflow 处理尚未发布的稳定
manifest；release guard 会拒绝该状态。

## 首次 bootstrap 新 package

npm package 存在之前无法配置 Trusted Publisher，因此首个版本是唯一例外：

1. 新 package 必须是 `0.1.0-rc.0`，位于经过 review 且干净的 `main`。
2. 执行：

   ```sh
   pnpm release:bootstrap
   ```

3. 完整检查后，命令掩码读取 OTP 并只发布 registry 中从未存在的 `rc.0`；随后
   等待 canonical registry，针对本次 package 幂等配置 Trusted Publisher，
   再执行 bootstrap 模式的 tag、integrity、tarball 与真实 consumer 验证。
   Trusted Publisher 阶段可能因 OTP 有效期而再次提示验证码。
4. 将 package 升为 `0.1.0-rc.1`，合并到 `main`，再走正常
   `release:request-next`。Consumer 不得采用 bootstrap `rc.0`。

`release:bootstrap` 是唯一允许省略 provenance 的发布路径。若本地普通发布出现
`Automatic provenance generation not supported for provider: null`，说明误用了
workflow 内部命令，不得通过全局关闭 provenance 绕过。

## 已固化的故障经验

### Node、pnpm 与 Windows CET

根 manifest 的 Node engine 是硬门禁。命令会使用当前 Node 启动从 pnpm/npm
shim 解析出的 JavaScript CLI，并始终使用 `shell: false`。Windows 下
`spawn('pnpm.cmd', args, { shell: false })` 会产生 `spawn EINVAL`；改用
`shell: true` 又会引入参数注入风险，因此两者都不使用。

如果当前 Node 本身报告 Windows 不支持 CET，应在系统级 Node 管理器中切换到
满足 `engines.node` 的正常安装，并确认 `node --version` 与
`pnpm exec node --version` 一致。不要把一次性的运行时目录塞到 `PATH` 前部。

### bootstrap 自动生成 `latest`

npm 创建全新 package 时要求存在 `latest`，即使明确以 `--tag next` 发布
`rc.0`，也可能同时生成 `next` 与 `latest`。这是 npm 的合法初始状态；不要调用
dist-tag DELETE 删除唯一的 `latest`，该操作会返回 HTTP 400。后续稳定版本会
自然接管 `latest`。

### npm trust 的输出并非单一 JSON

npm 可能在标准输出中连续写出多个 JSON document，并在标准错误中写出来自
pnpm `.npmrc` 的配置 warning。正式脚本会提取完整 JSON documents、先读取现有
配置、跳过匹配项、只创建缺失项，再重新读取确认。不要复制临时的单次
`JSON.parse(stdout)` 脚本。

### canonical registry 与镜像延迟

发布验证只读取根 `.npmrc` 指向的 `https://registry.npmjs.org`。第三方镜像可能
在 metadata 已出现后仍无法下载 tarball，或长时间看不到新版本；镜像延迟不能
作为重新 publish、改版本或移动 dist-tag 的理由。工具会分别轮询 metadata 与
tarball、验证 `dist.integrity`，超时后保留原发布结论并报告传播失败。

### prerelease 内部依赖

发布顺序由 `dependencies`、`devDependencies`、`optionalDependencies` 与
`peerDependencies` 的 workspace 图确定，dependency 永远先于 dependant。真实
consumer 会为全部 workspace package 自动生成精确 dependencies 和 overrides，
避免刚发布的 Provider 因 registry 尚未出现其 prerelease Core 而解析失败。

## 验证标准

每个目标 package/version 必须同时满足：

- canonical registry metadata 已包含该版本；
- `next` 或 `latest` 指向目标版本；bootstrap `rc.0` 允许同时占用两者；
- tarball 可下载且内容与 `dist.integrity` 一致；
- workflow 发布具有 SLSA v1 provenance，且 package、version、digest、repository、
  workflow、ref 和 commit 全部匹配；
- 对应 `<package>@<version>` tag 存在并指向 provenance commit；
- clean consumer 能安装 registry 精确版本、导入所有显式 public exports、执行
  自动发现的 package consumer smoke 和 CLI fixtures。

成功的 workflow 本身不是发布成功的充分证据。上述验证全部通过后，才允许迁移
consumer。

## 失败规则

- Actions 无法创建或更新 Version PR 时，先检查仓库 Actions 权限，不要修改
  publish 认证模型。
- `npm trust` 不可用时，使用 release policy 固定的 npm trust CLI；不要引入
  npm token。
- 手动 prerelease 缺 tag 时，确认 workflow 使用 `git push origin --tags`；
  `--follow-tags` 不会推送脚本创建的 lightweight tag。
- Changesets Action 无法读取 `CHANGESETS_OUTPUT` 时，publish 可能已成功但 tag
  和 GitHub Release 未完成。脚本必须为每个新版本写入：

  ```json
  {"type":"git-tag","tag":"@openge/example@1.2.3","packageName":"@openge/example"}
  ```

  必须从 provenance 恢复精确 source commit 后再修复 tag，不得把已发布版本绑定
  到当前 commit。
- package、provenance、tarball、tag 或 consumer 任一验证失败时，停止下游迁移；
  修复根因后重跑幂等流程，不得 unpublish 或静默移动 dist-tag。
