# Windows 验收启动与取消边界

适用于仓库 Windows 验收的闪窗或取消排查。此文描述可复核的控制点，不授予启动、终止、提权或系统访问权限。静态/纯注入、两次分别获准的最小 lifecycle／取消探针，以及一次获准的 C/D 均已完成。第二次短探针用户反馈「没有看到窗口闪现」，该观察仅支持该短链；D 的正式门禁和退场已通过，全部路径无闪窗仍缺少直接观察证据。各次许可已使用，后续执行遵循当前具体授权。

## 显式 pnpm 适配入口

候选入口为 node scripts/hidden-pnpm/pnpm.cjs 后接原 pnpm 参数。它在同一个 Node 进程内加载已安装的真实 CLI；根 packageManager 必须匹配已审阅的 pnpm 10.33.2，实际入口必须匹配 manifest.bin.pnpm，入口和 bundle 两份固定指纹变化均拒绝；纯校验始终使用 Windows 路径语义。现有 package-manager resolver、release 执行器和 pnpm self-invocation 继续通过名为 pnpm.cjs 的主入口；lifecycle 内字面量 pnpm 通过本进程 PATH 最前的 pnpm.cmd 转回此入口。

这是显式选择的入口。普通外部 pnpm 启动不自动安装适配，初始 Node 自身仍须由经过批准的隐藏宿主创建。2026-10-27 的一次 D 已在独立审批下由受管隐藏宿主调用此入口，完成正式 pnpm check；该次许可不自动授权另一轮。

适配只给该 pnpm 进程的 spawn / spawnSync 补 windowsHide，并检查共享取消门闩。原 cmd /d /s /c、argv、stdio、env、shell 解释、返回对象和错误继续交给真实 pnpm / Node。非法参数不被补丁修成合法启动。环境变更限本进程的 PATH、npm_execpath 和两个 FORGE_CHECK 入口变量，退出或同步加载失败时恢复；不替换 Windows process.env 对象。

不设置或传播隐藏 preload，不修改 node_modules、全局 pnpm、注册表或系统设置。supervisorEnvironment 对 NODE_OPTIONS、NODE_PATH 等变量的清除保持不变。pnpm 运行时环境的显式入口信息通过正常 environment 契约传递。

## 启动边界

| 边界 | 本轮控制点 | 证据与限制 |
|---|---|---|
| 宿主 → 初始 Node | 宿主的 CreateNoWindow / WindowStyle / 重定向参数 | 两次专用探针已创建；第二次用户未见闪窗，仅支持该链路 |
| pnpm → lifecycle cmd | 固定 bundle 加载前安装 spawn 适配 | 实际 lifecycle 源码和纯参数注入；未证明桌面不可见 |
| cmd → node / pnpm.cmd | 保留原 shell；局部 PATH shim 显式加载适配入口 | 不改 shell 解释；cmd 的原生创建行为仍需真实证据 |
| check-runner → pnpm → check-full | 原 package-manager-command 解析，直接启动已有 windowsHide；共用取消文件 | 保留 pnpm lifecycle，没有改成跳过 lifecycle 的直接函数调用 |
| build / typecheck → recursive pnpm | 同名 pnpm.cjs 与局部 PATH 包装 | 需在最小验证中确认 PATH 解析；不承诺覆盖主动覆写 PATH 的任意程序 |
| context → supervisor → scope-host | 原 owned-scope provider / Job，原 hidden、detached 和超时 | 未修改原生 Provider、隔离或 1 秒自然退出判定 |
| coverage / consumer → 被测进程 | 既有 context / observer；项目直接调用补齐 20 处 hide | 26 个调用表达式契约；仍保留所有真实集成断言 |
| Git 或其他原生程序 → 孙进程 | 沿用原行为 | 不受 Node spawn 适配全面控制，尚无窗口级证明 |
| pnpm 的其他内部路径 | 只声明已审阅 lifecycle / execa 的 spawn 边界 | execFile / fork 内部绑定、可执行文件直接创建进程等不属于普遍隐藏保证 |

固定版本 [Node 的参数规范化实现](https://github.com/nodejs/node/blob/v24.11.1/lib/child_process.js#L532) 是重载保留的依据。参数契约和 OS 可见性是两种证据，不能互相替代。

## 受控取消

check CLI 输出自己这一轮的 cancellation file。受支持的操作是向该自有文件写入取消标记；同一运行的 driver、pnpm 适配和 context 观察此门闩。不要把终止外层 launcher 当成取消通道。

顺序为：停止预算排队和下一次 scope 启动 → AbortSignal 通知活动 scope 使用原 terminate / dispose → 等全部活动 promise 和已分配租约收尾 → 按原 worker 事件与 Job closure 审核。pre-abort 零 scope，取消发生在预算出队后仍禁止创建 scope；identity / bind 后再次检查，禁止取消后授权。尚未创建日志时不以 ENOENT 覆盖取消原因。最终 finalize 或输出读取期间观察到取消，仍按失败结束。Job 等待原有 termination / dispose / completion 后复查取消，再同步写小型终态 JSON；已完成 Job 的历史结果不随更晚的全局取消追改。

成功收据先在 UUID 独占暂存文件内完成异步写入与关闭，最后连续检查取消并同步 rename 发布。发布前取消只清理本次已取得所有权的暂存，不回滚共享 state.json；成功发布是提交点，私有提交标记贯通各检查模式，后续取消不把已提交成功改判失败。未返回该标记的注入 persist 仍须通过末尾取消检查。同步终态段只处理小型元数据，原 Job 退出、租约、timeout 与 worker 上限不变。

取消文件是协作通道，不是根 Job。构建前的普通命令等待当前进程关闭；硬杀外层、同步命令阻塞事件循环或不合作的原生子进程，不由此推导立即整链停止。未新增专有根 Job：现有适配器直接导入 dist/index.js，干净 checkout 的首次构建前不可复用；本轮不为此引入另一套原生启动框架。若必须保证这一阶段的强制整树关闭，需要另行审阅其最小宿主方案。

## 回归与恢复门槛

项目内持久回归：

- scripts/tests/check-cancellation.test.mjs：阶段门闩、pre-abort、队列/活动任务、身份查询中取消、预算尾部等待、异步收尾中的晚到取消、自有收据暂存及并发隔离、提交点。
- scripts/tests/hidden-pnpm.test.mjs：隐藏参数、重载/异常、版本／入口映射／入口及 bundle 指纹拒绝、环境恢复、共享文件门闩。
- scripts/tests/spawn-options.test.mjs：已确认 26 个实际调用表达式，进程函数全部使用替身。

这些文件不依赖 ignored 诊断输入。纯注入使用既有隔离运行时和不可透传的 OS 替身；不等于 Node 原生 AbortSignal、真实 Job、真实 pnpm 或完整门禁通过。

恢复前须有父任务对具体最小启动方案的确认，以及适用工具对具体命令的审批。单例旧审批不自动覆盖新命令或全量。首次真实探测仍可能闪窗；无法接受这项剩余风险时，应维持暂停，并安排用户不受干扰的时间/环境，不能自行更改桌面或安全设置。

最小真实方案为单次、串行、最多一个活动测试 worker 的自有 fixture：直接隐藏 Node 宿主，复用已构建的正式 context / observer / Job；先验证短 pnpm lifecycle 与一次嵌套 pnpm，再在同一归属链验证取消后不启动下一阶段及 Job 空。执行工作预算不超过 5 秒；原 terminate / dispose 的 10 秒期限保持原值，最迟 15 秒转交失败或不确定状态，不继续启动任何案例。这个预算不修改产品或测试原 timeout。若父要求先只验证纯回归，可先用禁用 child-process / worker / addons 的单 Node 权限入口；该步骤仍不能证明 cmd 或 Git 后代不可见。

首次闪窗、身份不符、未知版本、权限拒绝、取消后仍启动、closure 不确定或期限耗尽即停止该次，不循环复现，不全局 CIM，不杀未知 PID。真实验证通过后再评估一次原全量；不能把这份计划或纯回归当成恢复许可。

补充回归边界：环境恢复及取消门闩关闭使用 Reflect.deleteProperty 时，返回 false 必须保持原严格 delete 的 TypeError，Proxy 抛出的值必须原样传播。原任务失败与暂存清理或输出读取失败同时发生时，AggregateError 必须保留两个错误及原任务 cause；不得用真假值判断丢弃异常。新增持久回归覆盖这些条件。2026-10-27 的限权单 Node A/B 已通过 44 项回归、全仓零警告 lint 和 release-vercel 类型检查；这不扩大真实启动许可，也不替代 C/D、真实 Job 或窗口观察。

C/D 实测的边界：C 实际显式选择3个既有Git回归文件，共37项，较原单文件6项计划扩大31项；不是默认附加，应在后续冻结准确用例集合。D 使用已冻结构建直接复用现有 runTestProcess 为本次完整命令提供外层Job，取消可终止归属明确的整个后代链。正式入口仍自带构建，正式测试不依赖临时宿主；这不意味着普通外部 pnpm 在首次构建前自动拥有根Job。98个正式验收Job及该外层Job均正常清空、峰值2、租约0；完整功能通过不证明全部窗口不可见，也不证明性能改善。1673.18秒比1302.75秒基线慢28.43%，详见实验记录。
