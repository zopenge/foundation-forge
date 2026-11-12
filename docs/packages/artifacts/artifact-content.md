# 制品内容身份与清单

`@openge/forge-artifact-publish` 的对象发布、文件发布、激活计划及独立操作绑定都要求 `content: { manifestSha256 }`。摘要是实际内容清单字节的 64 位小写 SHA-256，不再要求存在 Git 仓库。可选 `provenance: { gitRevision }` 仅记录真实的 40 或 64 位小写 Git revision；没有 Git 来源时省略，不伪造 revision。内容身份与可选 provenance 都进入操作 fingerprint 和回执快照。

## 清单 v1

`createArtifactContentManifest({ schemaVersion: 1, files })` 返回规范化的 `manifest`、实际 UTF-8 `bytes` 和对应 `content`。根入口无 Node 或厂商运行时依赖。它只处理声明，不读取、认证或上传负载；消费者须先核实文件真实字节与声明相符，并把返回的清单字节作为稳定输入保存。

每个文件具有精确字段：

| 字段 | 规则 |
| --- | --- |
| `path` | 唯一、便携的相对路径，最多 1,024 UTF-8 字节，无控制符 |
| `role` | `asset` 或 `control` |
| `byteLength` | 非负安全整数；所有文件长度之和也是安全整数 |
| `sha256` | 负载实际字节的 64 位小写 SHA-256 |
| `responseHeaders` | 仅 asset 必需；包含显式 Content-Type 与 Cache-Control，可声明其他响应策略 |

control 文件记录会影响部署行为的控制输入的精确字节，例如路由或响应策略文件，不接受 `responseHeaders`。清单包含 1–10,000 个文件，规范字节最多 1 MiB；根及文件对象拒绝未知字段，重复路径不能被静默覆盖。

响应头名称按 ASCII token 校验并转小写，拒绝大小写别名冲突；名称最多 256 字符。值为 1–2,048 字符的可打印 ASCII，不能带首尾空白。规范文件顺序按 JavaScript 字符串比较排序，不使用 locale。对象字段依次为 `path`、`role`、`byteLength`、`sha256`、可选 `responseHeaders`；根字段依次为 `schemaVersion`、`files`。响应头先按名称排序插入，再采用 ECMAScript `JSON.stringify` 的属性枚举规则，因此整数索引形式的名称先按数值枚举。结果不带缩进、BOM 或末尾换行；SHA-256 针对这些实际 UTF-8 字节计算。

清单不包含自身或最终 operation fingerprint，避免循环摘要；其他控制与关联文件按其实际字节纳入。元数据快照被冻结；返回的 `Uint8Array` 仍是可变字节，调用方不得修改后继续使用原摘要，修改必须重新生成身份。

## 绑定与真实性

独立操作应将清单也列为 `inputs` 描述符，名称由消费者稳定定义，`sha256` 等于 `content.manifestSha256`，长度为实际清单字节长度；其他制品描述符仍按能力需要列出。Core 绑定声明，适配器负责验证真实远端内容及同一部署身份。回显 fingerprint、metadata 或清单摘要不能认证负载、权限或来源。

对象发布入口验证对象及指针的字节、长度、Content-Type、Cache-Control。清单中其他响应头或控制文件对实际部署的效果，需要消费者的观察适配核实；不能由基础对象 GET 验证推断全部响应策略已生效。

## schema 与迁移

`ArtifactOperationRecord.schemaVersion` 和 `ArtifactPublicationReceipt.schemaVersion` 均为 **2**；内容清单自身版本为 **1**。外层 `ArtifactOperationReceipt` 没有额外 schema 字段。旧 `sourceCommit` 输入被拒绝；旧操作记录被拒绝读取，不自动迁移或重新派发未知副作用。消费者须保留旧恢复工具和证据，在原协调边界内完成核实后决定后续动作。

Node 命令适配注入 `FORGE_ARTIFACT_REQUEST_ID`、`FORGE_ARTIFACT_FINGERPRINT`、`FORGE_ARTIFACT_CONTENT_MANIFEST_SHA256`，仅在提供真实 provenance 时注入 `FORGE_ARTIFACT_GIT_REVISION`。不再注入 `FORGE_ARTIFACT_SOURCE_COMMIT`。这些新旧关联键均为保留键，调用方不能在替换环境中提供，包括不同大小写拼写。网站发布包的真实 Git 前置要求不因本契约调整而改变。

## 单次观察与运行时验证

四种既有 capability 继续描述独立事实。一次调用只执行一次 observe，pending 可以正常返回；下一 HTTP 请求或进程使用相同 binding、持久 journal 和新的只读 observer 再观察。稳定 reference、CAS 和 confirmed closure 仍是必需条件。业务进度、调度和厂商适配由消费者维护，不新增任务框架或 Pages Provider。

正式包消费 fixture 从真实 tarball 解析公开 SDK，并使用真实 Node 受管命令和 workerd 的 SQLite Durable Object 存储。workerd 测试显式设置 `no_nodejs_compat` 与 `no_nodejs_compat_v2`，断言没有 Node 全局，验证重启恢复、跨请求 pending、防重、旧记录拒绝及关闭不确定路径。新兼容日期默认启用 Node 兼容，关闭方式见 [Cloudflare 官方兼容说明](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)。本地引擎验收不能替代真实云网络、账号权限、限额或产品验收。
