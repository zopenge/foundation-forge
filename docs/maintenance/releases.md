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
  consumer。失败的同 commit workflow 只有传入 `--retry` 才会重新派发。
- `pnpm release:dispatch-next`：只完成安全预检和 workflow 派发/复用，适合
  分步排障。
- `pnpm release:status --sha <commit>`：读取精确 commit 的 run、jobs 和
  steps；追加 `--logs` 时通过 Git Credential Manager 读取并脱敏筛选失败日志。
- `pnpm release:verify --mode next|stable|bootstrap`：独立执行 registry
  验证；可重复传入 `--package <name>` 缩小范围。
- `pnpm release:configure-trusted-publishers`：幂等检查所有公开 package，
  仅配置缺失项；也可重复传入 `--package <name>`。OTP 掩码读取且不会写入
  参数、Git、文件或日志。

pnpm 脚本参数直接写在命令后，不添加额外的 `--`。例如
`pnpm release:verify --mode bootstrap --package <name>`；多写的 `--` 会被传入
发布脚本并触发 `unknown argument: --`。

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
4. workflow 结束后运行 `pnpm release:verify --mode stable`；验证通过前不迁移
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

### 启动前快速定位

| 现象 | 已确认原因 | 正确处理与成功判据 |
| --- | --- | --- |
| PowerShell 或 Node 在执行脚本前报告 CET 不兼容 | 运行时或工具宿主与系统 CET 支持不匹配 | 使用满足 engine 的正常系统安装；先核对 Node 与 pnpm 内的 Node 版本，不反复启动同一失败宿主 |
| 原生 cmd 连 `/c ver` 都报告路径语法错误 | 本环境中的 cmd 可执行文件绝对路径使用了正斜杠 | 用 `win32.normalize(ComSpec)` 生成反斜杠路径；先确认 `/d /c ver` 成功 |
| 完整检查结束后仍无法输入 OTP | 标准输入连接到了 pipe，而不是真实控制台 | 打开独立交互窗口并继承 stdin；实际看到掩码提示后才算启动成功 |
| pnpm 脚本报 `unknown argument: --` | 额外的 `--` 被原样转交给严格参数解析器 | 直接使用 `pnpm release:verify --mode bootstrap` 等命令，再追加所需参数 |
| 包已发布，但 bootstrap 报旧版本缺 Git tag | 发布阶段按顺序校验既有版本，历史 tag 不完整 | 保留已发布包，查明旧 tag 的来源；按明确包列表完成 Trusted Publisher 和 bootstrap 验证 |
| publish 成功且 tarball 可下载，但 metadata 暂时 404 | canonical registry 的元数据传播延迟 | 等待原版本传播并重跑验证；不同 URL 编码短期返回不同结果也不能直接认定为脚本故障 |

启动器退出码只证明启动命令执行完成。认证成功必须由 Trusted Publisher 回读确认，
发布成功必须由下文的 registry、provenance、tag 和真实 consumer 验证共同确认。

### Node、pnpm 与 Windows CET

根 manifest 的 Node engine 是硬门禁。命令会使用当前 Node 启动从 pnpm/npm
shim 解析出的 JavaScript CLI，并始终使用 `shell: false`。Windows 下
`spawn('pnpm.cmd', args, { shell: false })` 会产生 `spawn EINVAL`；改用
`shell: true` 又会引入参数注入风险，因此两者都不使用。

如果当前 Node 本身报告 Windows 不支持 CET，应在系统级 Node 管理器中切换到
满足 `engines.node` 的正常安装，并确认 `node --version` 与
`pnpm exec node --version` 一致。不要把一次性的运行时目录塞到 `PATH` 前部。

### Windows 自动化启动交互式 OTP 终端

Bootstrap 与 Trusted Publisher 配置必须连接真实控制台的标准输入。普通工具进程的
stdin pipe 不能用于掩码读取；不要为绕过这个要求伪造 isTTY，也不要把验证码写进
聊天、命令参数、脚本、环境配置文件或日志。

已验证的启动顺序如下：

1. 从 Git 元数据取得仓库根，确认当前发布 commit 已经通过检查，且位于干净、已推送的 main。
2. 在仓库忽略的 .tmp/release/ 下准备批处理入口。入口先用
   cd /d "%~dp0..\.." 回到仓库根，再执行 call pnpm release:bootstrap。
   遇到已有部分发布时，按下面的恢复步骤选择后续命令，不重复发布。
3. 通过 Windows command processor 的 start 命令打开独立交互控制台；若使用
   Node 启动，必须先对 ComSpec 调用 node:path 的 win32.normalize，保证
   cmd.exe 的绝对路径使用反斜杠。直接传入 C:/Windows/System32/cmd.exe 会在本环境
   报“文件名、目录名或卷标语法不正确”，甚至 /c ver 也失败；使用反斜杠路径后正常。
4. 将包含 start 命令的启动行放进临时 .cmd 文件，再以参数数组调用
   cmd.exe /d /c <启动文件>，避免在工具调用中反复嵌套引号。start 的第一个带引号
   参数是窗口标题，工作目录通过 /D 明确指定。
5. 若需要转存输出，包装器的子进程使用 stdio: ['inherit', 'pipe', 'pipe']，保留
   stdin 的真实 TTY；只转存 stdout/stderr，绝不读取、复制或记录输入。
6. 只有日志实际出现 npm one-time password:，且控制台输入显示星号，才确认
   OTP 入口已成功启动。进程启动成功或通过完整检查都不能代替这一确认。

采用已安装、满足 engines.node 的正常 Node；自动化进程缺少 Node 的 PATH 时，
只能补入该正常安装目录，不能换成临时下载的运行时或关闭 CET。还应在同一环境确认
node --version 与 pnpm exec node --version 一致。Windows PowerShell 工具自身因
CET 无法启动时，使用上述原生 cmd 控制台入口，不反复重试同一个失败的工具启动链。

可复用的两个临时入口如下；路径固定在仓库自己的 .tmp/release/，内容不含凭据。

launch-bootstrap.cmd：

```bat
@echo off
start "Foundation Forge npm bootstrap" /D "%~dp0..\.." "%ComSpec%" /d /k ".tmp\release\bootstrap-session.cmd"
```

bootstrap-session.cmd：

```bat
@echo off
cd /d "%~dp0..\.."
call pnpm release:bootstrap
```

自动化用真实 Node 脚本执行下面的启动片段。工具 REPL 若没有 process 全局，先把
片段保存到忽略的 .tmp 文件，再用正常安装的 Node 执行，不在受限 REPL 内拼接 shell。

```js
import { execFileSync, spawn } from 'node:child_process';
import { win32 } from 'node:path';

const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
if (!process.env.ComSpec) throw new Error('COMSPEC_MISSING');
spawn(win32.normalize(process.env.ComSpec), [
  '/d', '/c', '.tmp\\release\\launch-bootstrap.cmd',
], { cwd: repositoryRoot, windowsHide: true, stdio: 'ignore' });
```

此处隐藏的只是短暂的启动器；start 创建的独立窗口用于用户亲自输入 OTP。
若需结构化完成状态，可由会话包装器在退出时写入 .tmp 下的状态文件，不能仅根据
start 的退出码判断发布或认证成功。

### Bootstrap 已发布部分 package 后中断

先读取 canonical registry 确认哪些目标版本已经存在，并保留成功发布时生成的
Git tag 和源 commit。已发布版本不能再次 publish，也不能把对应 tag 移到当前 HEAD。

若失败发生在既有 package 的缺失 tag 校验，先检查远端 tag；仅在有可信源 commit
证据时恢复。缺少 provenance、gitHead 或原始发布记录时，不得猜测旧 tag。
已成功创建的新 package 可继续按明确的 --package 列表配置 Trusted Publisher，
再执行 release:verify --mode bootstrap 的同一目标列表，完成尚未执行的阶段。
随后为本次改动准备下一版 RC，经 main workflow 发布并验证新版本的 provenance 与 tag。
旧版元数据缺口必须保留在交付证据中，不得将其描述为已修复。

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
