# 本地验证与复用

日常开发在本地运行 `pnpm check`，提交和 PR 不自动启动 CI。需要强制完整本地验收时运行 `pnpm check:full`；缓存缺失时 `pnpm check` 也会进入完整检查。

`pnpm check` 使用工作区文件指纹及已验证的构建产物、真实包哈希选择检查范围：

- 指纹完全一致且构建产物、真实包仍匹配时，复用上次通过的结果。
- 仅 Markdown 文档或 Changeset 变化时，复核已验证产物与包哈希并运行零警告 lint。
- 包内 `src/`、`tests/` 或 README 变化时，按工作区依赖图确定受影响包，源码变化另纳入传递下游包。受影响包是全仓的真子集时，单包与包组使用同一流程：清理目标包旧构建，按依赖顺序重建，运行类型检查、覆盖率、浏览器边界和真实包消费验证；全仓脚本测试、零警告 lint 和 Markdown 本地链接检查也重新运行。同次文档和 Changeset 修改不扩大到全仓。
- 仅 `scripts/tests/` 内的脚本测试或夹具、`scripts/ab-eval.mjs` 与 `scripts/ab-eval/` 内的评估工具，或包目录 `evaluation/` 下未列入该包 `files` 的 `.mjs` 工具变化时，运行全仓零警告 lint 与全部脚本测试；后一种复用要求包清单的 `files` 为明确路径列表，不接受通配写法。写入新收据前再次核对输入指纹、所有构建产物和真实包哈希。构建、打包及检查调度脚本等其他脚本修改仍触发完整检查。
- 清单、检查调度脚本、环境、文件删除或全仓包受影响时触发完整检查。缓存缺失或未受影响产物不匹配也回到完整检查。

文档模式与脚本测试模式都会重新检查 Markdown 本地链接。所有复用路径在文档及产物检查结束后再次确认输入未变化；未重新验证的产物沿用原收据哈希，目标包只更新本次验证过的产物哈希。上述复用只适用于相同输入的已通过结果。未完成、失败或输入变化都不能记作通过。修改中文内容后还须检查乱码和可读性。

完整检查由 `scripts/check-full.mjs` 调度：lint 与脚本测试可和真实包验证同时运行；所有包先清理旧构建并重建，然后才启动类型检查和循环依赖检查。覆盖率在真实包验证及其他检查完成后运行，避免构建清理 `dist` 时读取工作区入口，也避免大包测试与打包争用资源。覆盖率脚本根据各包测试文件数量安排启动顺序，默认逐包运行每个包原有的 `test:coverage` 命令，包内仍使用各自的 worker 设置；避免在有限 CI 核数上叠加包间和包内并行。真实包消费验证在安装完成后同时运行公开入口导入和各包 smoke，等待两者全部结束并保留失败结果。

## 手动 CI 验收

`.github/workflows/ci.yml` 仅接受 `workflow_dispatch`。不添加 push、PR、schedule、`workflow_run`、`workflow_call`、`repository_dispatch` 等自动或间接入口，也不从其他自动化中代为 dispatch CI。默认分支合入此配置后才完成策略切换；仅更新开发分支时，默认分支的旧触发器仍可能运行。

发布前由维护者执行一次完整手动验收：

1. 确认候选提交已推送，工作区干净，并记录 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/<branch>` 返回的精确 SHA，两者必须一致。
2. 在 GitHub Actions 的 CI 页面选择验收分支并执行 Run workflow，或显式运行 `gh workflow run ci.yml --ref <branch>`。默认分支必须已包含 `workflow_dispatch` 配置。不要自动重试或用占位成功状态替代验收。
3. 使用 `gh run list --workflow ci.yml --branch <branch> --event workflow_dispatch --json databaseId,headSha,event,status,conclusion` 找到本次运行，再用 `gh run view <run-id> --json headSha,event,status,conclusion,jobs` 核对事件、精确 SHA 和结果。必须是候选 SHA，所有矩阵任务均成功，不能接受旧运行、跳过任务或仅有部分平台通过。
4. 保留运行链接和候选 SHA 作为验收证据。Linux Ubuntu 24.04 上的 Node.js 22、24、26，以及 Windows 2025 上的 Node.js 24 均运行冻结依赖安装与原有 `pnpm check`，涵盖构建、lint、类型检查、循环依赖、覆盖率、浏览器边界和真实 tarball 消费验证。
5. 候选提交发生任何变化后重新验收并核对新 SHA；合并或发布时再次确认实际交付 SHA 与验收证据一致。

切换前只读核实目标分支的 required status checks、规则集及合并队列。手动运行绑定候选提交；若保护要求其他提交或自动事件的检查，先明确满足方式和所需最小规则调整，再由维护者确认。不得自行降低保护、伪造状态或绕过权限错误；未解决的 required checks 应作为合并阻塞报告，避免永久 pending。

独立的 `.github/workflows/release.yml` 继续沿用 main push 与手动预发布入口，按[发布流程](releases.md)执行；它不会代为启动 CI。手动 CI 策略不取消发布流程自身的 `pnpm check`、构建、打包验证与发布门禁，main 更新仍保留原有自动发包契约。
