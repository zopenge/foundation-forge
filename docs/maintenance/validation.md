# 本地验证与复用

日常开发在本地运行 `pnpm check`，提交和 PR 不自动启动 CI。需要强制完整本地验收时运行 `pnpm check:full`；缓存缺失时 `pnpm check` 也会进入完整检查。`pnpm check:serial` 强制完整检查并额外将独立测试任务预算设为一，供诊断使用；重阶段顺序与默认完整检查相同。

`pnpm check` 使用工作区文件指纹及已验证的构建产物、真实包哈希选择检查范围：

- 指纹完全一致且构建产物、真实包仍匹配时，复用上次通过的结果。
- 仅 Markdown 文档或 Changeset 变化时，复核已验证产物与包哈希并运行零警告 lint。
- 包内 `src/`、`tests/` 或 README 变化时，按工作区依赖图确定受影响包，源码变化另纳入传递下游包。受影响包是全仓的真子集时，单包与包组使用同一流程：先运行零警告 lint，清理目标包旧构建并按依赖顺序重建一次，完整执行真实包、浏览器边界与消费者验证，再按目标包顺序完成类型检查，最后运行全仓脚本测试和选中包覆盖率。Markdown 本地链接检查也重新运行。同次文档和 Changeset 修改不扩大到全仓。
- 仅 `scripts/tests/` 内的脚本测试或夹具、`scripts/ab-eval.mjs` 与 `scripts/ab-eval/` 内的评估工具，或包目录 `evaluation/` 下未列入该包 `files` 的 `.mjs` 工具变化时，运行全仓零警告 lint 与全部脚本测试；后一种复用要求包清单的 `files` 为明确路径列表，不接受通配写法。写入新收据前再次核对输入指纹、所有构建产物和真实包哈希。构建、打包及检查调度脚本等其他脚本修改仍触发完整检查。
- 清单、检查调度脚本、环境、文件删除或全仓包受影响时触发完整检查。缓存缺失或未受影响产物不匹配也回到完整检查。

文档模式与脚本测试模式都会重新检查 Markdown 本地链接。所有复用路径在文档及产物检查结束后再次确认输入未变化；未重新验证的产物沿用原收据哈希，目标包只更新本次验证过的产物哈希。上述复用只适用于相同输入的已通过结果。未完成、失败或输入变化都不能记作通过。修改中文内容后还须检查乱码和可读性。

完整检查由 `scripts/check-full.mjs` 调度，重阶段依次为：零警告 lint → 包验证 → 类型检查 → 循环依赖检查 → 全仓脚本测试 → 全部包覆盖率 → context 最终审计。包验证内部保留清理旧 `dist`、一次构建、打包及浏览器边界、消费者安装和真实入口/烟雾检查；构建后的 `onBuilt` 只建立共享 context，不启动后续重阶段。消费者测试在同步打包结束后使用该 context，全部收尾后包验证才返回；消费者及测试仍在读取产物时不能重建或清理 `dist`。定向包组沿用其原有验证范围并遵循同一阶段顺序；脚本复用模式先完成 lint，再启动脚本测试。任何阶段失败都不启动后续阶段，已经启动的阶段内部兄弟任务须完成收尾。

阶段顺序不改变构建或打包工具既有的内部并发配置，也不等于整个验收最多只有两个 OS 进程。共享 worker 预算约束独立测试执行；context 关闭审计完成后才能报告完整检查完成或写入定向成功收据。

完整、定向包组和独立测试入口默认共享最多 **2 个测试 worker**；`FORGE_CHECK_TEST_WORKERS` 只接受 `1` 或 `2`，不会提高系统资源限制。普通包的 `package.verify.json` 默认声明1槽，release-vercel声明2槽；声明是偏好上限，实际分配取总预算与声明的较小值。2槽包运行时不同时启动其他包；同包保持单个Vitest实例，由其fork池执行文件并原生合并完整覆盖率。配置包装保留包的setup、文件选择、覆盖率provider与门槛；不使用额外包池叠加文件池，也不选用定向路径的高并发fast命令。

Node脚本阶段保留整个预算，逐文件启动1个Node测试worker，首个失败后不启动后续文件；其真实Vitest故障fixture仅允许另一个worker。消费者入口导入和每个smoke各占1槽，使用同一预算。测试场景必需的Git、应用、原生监督及故障子进程继续保留；串行诊断入口不禁止这些被测子进程。

每个脚本文件仍由独立受管CLI提供进程隔离；CLI使用Node官方的`--experimental-test-isolation=none`，避免再产生未受隐藏参数控制的内层测试进程，不把多个文件放进同一进程。Vitest通过公开pool接口使用原有forks worker，保留IPC、文件隔离、setup和覆盖率执行；后台启动显式隐藏控制台并保留日志管道。

Vitest调度编号可能在旧worker退出前复用，因此真实fork槽持有到父侧观察到OS进程`exit`才释放，不能以afterAll、子进程exit回调或“开始收尾”代替。输出排空沿用项目的`teardownTimeout`；失败会停止后续fork、记入Vitest错误状态并令CLI非零退出，随后由原生作用域核实后代关闭，不能仅记录日志后通过。

测试命令先绑定原生作用域身份再授权执行，等待命令及后代关闭后才归还槽。首个失败停止新排队任务，已运行的兄弟完成收尾后才返回；异常作用域即使已强制清空也不能记作成功。每次运行在忽略目录 `.tmp/check-runs/` 保留独立日志、worker事件、进程关闭证明和覆盖率；同包只有一个Vitest实例，不拆分门槛。全部包成功后才暂存各包覆盖率报告及完整清单；复制和汇总写入完成后再替换旧报告，可捕获的替换错误会回滚。旧报告备份保留在本次运行目录，回滚失败会报告错误及恢复位置。该步骤不承诺跨目录原子可见或进程崩溃后的自动恢复。

独立运行 `pnpm test:scripts` 或 `pnpm test:coverage` 前须先运行仓库标准构建 `pnpm build`；完整检查自带该构建步骤，不依赖历史 `.tmp` 或手工预置产物。验证监督器按包内 `test-process-scope.mjs` 约定发现，使用现有显式Windows/Linux Provider，不引入无监督回退。

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
