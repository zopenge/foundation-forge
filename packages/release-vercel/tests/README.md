# 验证分层与安全边界

测试按要捕获的失败机制划分。组件测试减少无关流程的重复执行，不把合成状态或边界错误当作完整发布成功；测试数量、覆盖率数字本身不能证明语义等价。

| 不变量 | 保留的真实验证 | 组件验证的边界 |
|---|---|---|
| 完整受管调用链、冻结 SHA/配置、应用环境及成功发布 | [managed-release.test.ts](managed-release.test.ts) 保留完整 check、准备阶段修改检测、真实 pnpm 版本拒绝、发布到两个本地 refs 与验收/verify；不使用组件执行器 | 复用、快进、缓存和锁文件字节由 [managed-checkout-reuse.test.ts](managed-checkout-reuse.test.ts) 经正常入口和真实 Git 验证；安装前返回明确 `FIXTURE_CHECKOUT_BOUNDARY` 错误，不伪报成功 |
| checkout 脏树/分叉、默认分支和 Windows 长路径 | [managed-install.test.ts](managed-install.test.ts) 仍创建真实仓库、执行 Git、核对原 HEAD/用户字节/锁文件及长路径；manifest 关闭失败回归保留原受管 session | `commandComponentSession` 只在 checkout/安装组件准备中使用普通真实命令，避免每个只读查询重复整个受管日志链路 |
| 推送接受但丢响应时保持 unknown 且不重放 | [managed-push-resume.test.ts](managed-push-resume.test.ts) 仍执行真实 bare Git push、注入已接受后的响应丢失、观察 refs、验证只推一次、归档 pendingPush 和真实终止凭证 | 只读 Git 查询仍新鲜执行；push/fetch、应用命令与未知指令保留原受管执行器。安装/checkout 前置组件与完整安装接入分开验证 |
| 协调器崩溃后的远端观察与资源收尾 | [managed-recovery-worker.test.ts](managed-recovery-worker.test.ts) 保留真实子进程、pre/post-receive hook、远端拒绝/接受、协调器退出/强制终止、进程身份和后代清理 | [managed-component-worker.mjs](helpers/managed-component-worker.mjs) 运行原公共入口，仅在测试子进程内把只读查询切换为普通真实执行；变更、应用命令及未知指令不切换 |
| 已停止 run 可被正常入口归档，失败安装可恢复 | [managed-resume.test.ts](managed-resume.test.ts) 的停止凭证仍由真实 worker 生成；真实 pnpm postinstall 首次失败、再次安装、原失败回执及 node_modules 标记保留 | closed/cancelled 入口归档在 checkout 后、安装前明确停止；完整成功安装不在这两个状态组合重复执行 |
| OS 归属、PID/后代、权限/链接、持久化与关闭不能被伪造 | managed-process、managed-terminal、managed-state-transaction、retirement 等测试及 process-control-node 的平台测试 | 不用组件适配器替代这些测试中的受管进程、文件身份或故障注入；完整端到端继续验证只读查询也接入受管日志 |

[component-session.test.ts](component-session.test.ts) 单独验证 session 与 worker 适配器：只读查询走真实查询，push、fetch、写 config、未知 Git/stream 指令及应用命令仍交给原受管边界。只读指令白名单位于 [component-command-runtime.mjs](helpers/component-command-runtime.mjs)，未知指令默认保留原执行，不按名称假定新指令安全。

worker 运行已构建的 `dist`，遵循仓库先 build、再测试/打包的标准顺序。所有 helper 随仓库维护，动态仓库、文件和进程在测试自有的 `.tmp/` 目录生成并清理；不能依赖历史缓存、手工输入或忽略目录中的诊断脚本。调试 hook 仅用于采样，不能成为测试通过的前提。

tarball smoke 仍使用两个独立仓库和完整受管调用链：alpha 通过真实 Node 子进程验证成功路径、CRLF 源文件及已退出协调器的历史退役拒绝；beta 先由 Node API 触发真实 postinstall 失败，再由 CLI 验证同 slot/路径恢复、失败回执、缓存、内部 junction、锁文件及冻结命令环境。两者都核对源文件/分支不变、远端 refs 不变。该矩阵避免每个项目重复所有 Node/CLI 组合，不以减少真实消费者或替换安装包为源代码来提速。
