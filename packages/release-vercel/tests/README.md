# 验证分层与安全边界

测试按要捕获的失败机制划分。组件测试减少无关流程的重复执行，不把合成状态或边界错误当作完整发布成功；测试数量、覆盖率数字本身不能证明语义等价。

Windows崩溃夹具通过[windows-fixture-ancestry.ts](helpers/windows-fixture-ancestry.ts)在单个PowerShell命令内发现自有父链并复核同一PID集合，每次CIM查询都带明确过滤，保留原10秒期限。返回前逐项核对协调器身份、父边、实例身份和完整集合；额外进程、替换、缺失或环均拒绝。[windows-fixture-ancestry.test.ts](windows-fixture-ancestry.test.ts)同时验证协议反例和真实父子进程，不以全机枚举或合成身份代替清理归属证明。

| 不变量 | 保留的真实验证 | 组件验证的边界 |
|---|---|---|
| 完整受管调用链、冻结 SHA/配置、应用环境及成功发布 | 真实 tarball 的 alpha 消费者通过公开 Node 入口执行完整 managed check，随后由实装 CLI 执行 recover；独立 beta 仓库验证 CLI workspace 成功与 managed 外来 slot 拒绝。[managed-release.test.ts](managed-release.test.ts) 保留真实 clone、fetch、两个本地 refs 的成功 push、验收及冻结配置 verify | 发布组件只读 Git 查询仍新鲜执行；真实变更、应用命令和未知指令保留受管日志。`protocolComponentSlot` 保留真实目录身份、原始锁与状态存储，不重复来源跟踪准入；首次 slot 准入、最终释放及专项来源测试仍执行原实现。复用、快进、缓存和锁文件字节由 [managed-checkout-reuse.test.ts](managed-checkout-reuse.test.ts) 单独验证 |
| 发布决策、平台验证与协调器报告 | [release.test.ts](release.test.ts) 保留真实 Git 发布、幂等、服务器竞态、锁替换/取消、回执选择，以及入场失败锁释放和推送后失败的恢复建议 | [publication.test.ts](publication.test.ts) 以完整 argv/次序的严格脚本覆盖失败矩阵、UNKNOWN checkpoint、effects、冻结守卫与平台请求；未知调用直接失败。[managed-publication-report.test.ts](managed-publication-report.test.ts) 通过生产协调器验证失败 effects、耐久 receipt、归档、恢复建议及真实锁释放；来源、checkout 和发布引擎仅作为组件输入，没有启动命令，也不生成合成 OS 关闭证明。假时钟只验证轮询和请求协议，不作为真实 OS 时限或关闭证据 |
| checkout 脏树/分叉、默认分支和 Windows 长路径 | [managed-install.test.ts](managed-install.test.ts) 仍创建真实仓库、执行 Git、核对原 HEAD/用户字节/锁文件及长路径；manifest 关闭失败回归保留原受管 session | `commandComponentSession` 只在 checkout/安装组件准备中使用普通真实命令，避免每个只读查询重复整个受管日志链路 |
| 推送接受但丢响应时保持 unknown 且不重放 | [managed-push-resume.test.ts](managed-push-resume.test.ts) 仍执行真实 bare Git push、注入已接受后的响应丢失、观察 refs、验证只推一次、归档 pendingPush 和真实终止凭证 | 只读 Git 查询仍新鲜执行；push/fetch、应用命令与未知指令保留原受管执行器。安装/checkout 前置组件与完整安装接入分开验证 |
| 协调器崩溃后的远端观察与资源收尾 | [managed-recovery-worker.test.ts](managed-recovery-worker.test.ts) 保留真实子进程、pre/post-receive hook、远端拒绝/接受、协调器退出/强制终止、进程身份和后代清理；公开recover期间明确断言零push，未知场景保留原state/lock字节 | [managed-push-phase-worker.mjs](helpers/managed-push-phase-worker.mjs) 只准备真实推送阶段：首次来源准入与独立checkout仍真实执行，随后使用真实路径、原始锁和原子存储的协议守卫。只有push声明完整受管日志/关闭边界，不重复安装、检查和部署成功链，也不声明完整发布成功 |
| 固定五查询批次的安全门禁、停止证明与崩溃恢复 | [managed-checkout-observation.test.ts](managed-checkout-observation.test.ts) 保留每条真实 Git、独立 scope、身份、准入、预算、取消与关闭；[managed-checkout-observation-crash.test.ts](managed-checkout-observation-crash.test.ts) 通过正式 worker 的真实退出覆盖首查询后、停止证明及 state rename 前后五个窗口，检查 UNKNOWN、停止事实、原 state/lock、无成功回执及远端 refs | 仅 `assertCheckoutFrozen` 的固定完整计划采用批次恢复粒度；停止证明耐久前整批保持 UNKNOWN。子 scope 关闭不替代批次证明，证明后的资源恢复不声明原操作成功；组件查询适配器显式不创建生产批次 |
| 已停止 run 可被正常入口归档，失败安装可恢复 | [managed-resume.test.ts](managed-resume.test.ts) 的停止凭证仍由真实 worker 生成；真实 pnpm postinstall 首次失败、再次安装、原失败回执及 node_modules 标记保留 | closed/cancelled 入口归档在 checkout 后、安装前明确停止；完整成功安装不在这两个状态组合重复执行 |
| OS 归属、PID/后代、权限/链接、持久化与关闭不能被伪造 | managed-process、managed-terminal、managed-state-transaction 与 process-control-node 的平台测试保留真实受管进程及文件故障；五窗口崩溃测试验证真实停止事实 | [managed-session-fixture.ts](helpers/managed-session-fixture.ts) 直接准备当前协议组件输入，保留真实目录、锁、身份和原子存储，输入 SHA 明确为合成值；不以此代替 Git 来源验证或生成成功回执 |
| 当前协议退役的宿主、锁、预算、取消和中断恢复 | [managed-retirement.test.ts](managed-retirement.test.ts) 操作真实文件、锁、状态、原生 lease/PID reader，并保留一个真实 claim 协调器强制终止 | 以 schema3 未决 intent 替代每例完整发布后再降级 schema2 的准备；精确 Git 脚本只提供组件输入，未知命令拒绝。注入的重启时间仅证明协议决策，历史始终 UNKNOWN；旧格式来源确认不再进入此矩阵 |
| 文件预算、链接解析、超限取消及元数据写入峰值 | [managed-budget.test.ts](managed-budget.test.ts) 保留全部真实文件计量、硬链接/junction、增长子进程及关闭断言；完整受管发布继续执行 Git 准入与同一预算监控 | [managed-budget-fixture.ts](helpers/managed-budget-fixture.ts) 直接准备测试自有目录、真实文件身份与互斥锁；锚点写入调用生产 `atomicJson`，保留元数据预留及可用空间检查。此夹具只准备预算组件输入，不生成发布成功回执或替代来源冻结验证 |

[component-session.test.ts](component-session.test.ts) 单独验证 session 与 worker 适配器：只读查询走真实查询，push、fetch、写 config、未知 Git/stream 指令及应用命令仍交给原受管边界。只读指令白名单位于 [component-command-runtime.mjs](helpers/component-command-runtime.mjs)，未知指令默认保留原执行，不按名称假定新指令安全。

worker 组件适配器只替换部分查询，因此同时替换并恢复测试范围内的 `observeCheckout`，避免把部分受管的组件操作误记为完整批次；`status` 仍通过原受管执行器。组件反例也在观察回调内执行原变更、未知指令和应用命令断言。

固定批次矩阵中，真实查询scope关闭、查询间来源索引变化、批次外写config/应用命令仍由 managed-checkout-observation 的3个集成场景承担，5个真实协调器崩溃窗口全部保留。取消、证明提交失败、state rename失败、旧证明拒绝、完整argv拒绝、首错和跨await迟到查询迁入 [managed-observation-protocol.test.ts](managed-observation-protocol.test.ts)：真实文件、目录身份、锁、状态与原子重命名不替换；命令边界只接收严格脚本的合成身份和关闭输入，不能当作真实OS停止证据。[scripted-command-runner.test.ts](scripted-command-runner.test.ts) 验证未知/乱序/非manual调用拒绝、授权前无输出或结果、取消和显式timeout模拟。真实进程取消及停止由 managed-process、managed-terminal 和真实崩溃测试继续验证。

managed-process、managed-terminal 使用直接准备的 session 协议夹具，来源准入由专门集成测试与 tarball 承担。managed-recovery 的11项集成测试仍通过 [committed-fixture-source.ts](helpers/committed-fixture-source.ts) 每次读取真实提交、配置 blob 与 remote；首次执行原 `openManagedSlot` 后，纯回执/状态准备使用协议 slot。来源、remote、anchor、配置切换、真实 ancestry、worker退出/停止凭证和真实远端后果保留完整准入；公开恢复入口不替换。另11项回执选择、身份判定、缺失checkout、已停止归档与陈旧观察决策迁入 [managed-recovery-protocol.test.ts](managed-recovery-protocol.test.ts)：直接准备独立真实目录与锁，通过生产session生成当前schema3，保留真实状态/回执/归档和PID查询；Git来源及远端是严格组件输入，未知命令拒绝，不把空命令集合当作真实子进程停止证明。[committed-fixture-source.test.ts](committed-fixture-source.test.ts) 对照原冻结结果并检查新提交不会复用旧配置。

managed-state 的7项集成保留首次固定slot/独占锁、foreign/unignored/junction/corrupt准入、来源新跟踪管理文件和slot重绑定；文件身份精度、锁替换、回执分离/UTF-8及大小限制、外部Git元数据/坏JSON、anchor绑定/大小5项迁入 [managed-state-storage.test.ts](managed-state-storage.test.ts)，直接准备独立真实目录/身份/锁/store，合成receipt只作为存储输入且明确失败，不证明真实发布或OS停止。

[managed-recovery-lock.test.ts](managed-recovery-lock.test.ts) 的3项锁协议直接准备独立真实目录、原始锁和当前schema3，并建立自有最小Git仓库/空HEAD；父侧与真实child的索引守卫继续实际查询，仓库根断言防止向上发现外层工作树。仅省去与锁协议无关的完整来源冻结/首次slot准备，state来源SHA仍明确是组件输入。独立claim互斥、替换锁不删除、真实恢复协调器被杀后的claim恢复与state原字节断言全部保留；没有合成OS关闭证明。

worker 运行已构建的 `dist`，遵循仓库先 build、再测试/打包的标准顺序。所有 helper 随仓库维护，动态仓库、文件和进程在测试自有的 `.tmp/` 目录生成并清理；不能依赖历史缓存、手工输入或忽略目录中的诊断脚本。调试 hook 仅用于采样，不能成为测试通过的前提。

`managedFixture` 在监督入口提供 `FORGE_CHECK_JOB_TEMP` 时，把动态仓库放入本次 Job 的短路径目录；没有该变量时仍从仓库 `.tmp/managed-release-tests` 新建独立夹具。正常用例继续自行 dispose；父侧仅在确认 Job 空且目录身份未改变后清理该 Job 根，防止 worker 取消时绕过 afterEach 留下仓库。身份改变、关闭未确认或清理失败必须报告并保留本次定位信息，不能扫描并删除历史同名目录。

[managed-fixture-git.ts](helpers/managed-fixture-git.ts) 仅用真实 Git `fast-import` 批量准备通用夹具的固定初始文件、两个提交和独立 bare remote，再用 `read-tree` 建立真实索引。`fastimport.unpackLimit=0` 只传给这两次准备命令，不写入 Git 配置；不共享对象库、工作树或 slot，也不复用文件身份、锁和凭证。固定文件使用 LF，准备阶段不测试 clean filter 或提交 hook；后续 `commit()`、发布 push/fetch、受管观察与故障注入仍执行原命令。[managed-fixture.test.ts](managed-fixture.test.ts) 检查提交字节/父关系/身份、分支和远端 refs、索引、独立 clone 与后续真实 commit/push，并验证准备失败时仅清理自有目录、保留原始错误及清理错误。checkout 的换行转换仍遵循 Git 配置，tarball 消费者继续覆盖 CRLF 来源。

[managed-budget-fixture.test.ts](managed-budget-fixture.test.ts) 验证预算组件在 Git 不可用时仍可创建真实资源、写入原子元数据，并核对夹具之间的隔离与清理边界。预算夹具每次从空目录生成，不复用旧 `.tmp/` 内容。

tarball smoke 使用两个独立仓库：alpha 通过真实 Node 子进程执行完整 managed check，同时验证 CRLF 源文件与内部 junction，再通过实装 CLI recover 验证已停止历史不被重写、未重新安装或执行检查；beta 通过实装 CLI 执行 workspace check，再提交 managed 配置并验证外来 slot 在安装和应用命令前被拒绝。alpha 核对当前 schema3 宿主证据和真实关闭状态；两者均核对冻结命令环境、锁文件字节、源文件/分支和远端 refs 不变。alpha 保留未跟踪辅助文件，beta 将辅助文件明确写入忽略规则，遵守 workspace 的脏树门禁。真实 postinstall 失败、同 slot/路径重试、失败回执与缓存保留由 managed-resume 专项继续验证。消费者不执行 publish；真实发布成功由上述 managed-release 代表链承担。旧格式 journal 的人为降级兼容场景已移除，不减少真实消费者，也不以源码目录替代安装包。

推送后果矩阵的首次失败由上述阶段worker产生，状态中的intent、身份、scope、终止凭证和失败receipt使用真实生产ManagedSession/原子存储。main拒绝、main已接受但协调器被杀、dev已接受但响应丢失分别保留真实Git时点；失败receipt明确只是阶段输入。丢响应后的第二次发布仍走公开publish，核对归档pendingPush、原终止凭证、dev只推一次和main的新推送。[managed-release.test.ts](managed-release.test.ts) 的双ref代表链保留完整发布成功，再在来源配置改变后通过公开verify执行原冻结验收。协调器失败报告接线由 managed-publication-report 的组件用例承担，真实远端后果与原生停止事实由阶段worker承担；不把阶段receipt当作公开协调器成功，也不在每个远端后果场景重跑整条成功准备链。

仓库完整覆盖率入口使用单个 Vitest projects 调用和共享隐藏 worker 池，各包仍保留自己的根目录、超时、设置与 worker 元数据；全局 `VITEST_MAX_WORKERS` 不得覆盖每包限额。真实 V8 数据按源码归属拆分，原 Istanbul 命中计数不改，再按包生成报告并沿原发布事务写入；未知来源、缺失项目结果或未支持的覆盖配置直接失败。脚本测试共用一个外层 owned Job，但每个文件继续运行独立 Node CLI，首败或取消不启动下一文件。
