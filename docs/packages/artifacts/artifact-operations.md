# 制品操作、显式适配与恢复

本能力属于 `@openge/forge-artifact-publish`。根入口提供 `bindArtifactOperation`、`performArtifactOperation`、`observeArtifactOperation`、`ArtifactOperationError` 及相关类型；Node 子入口增加 `createCommandArtifactOperation`。原有对象发布及 COS API 继续有效。

## 支持范围

| 能力 | Foundation 实现 | 适配及消费者责任 | 证据范围 |
| --- | --- | --- | --- |
| 不可变对象与指针 | 字节/元数据核验、最后切换指针、有限并发及关闭 | 显式对象 transport；签名、目录和准入由消费者持有 | 真实文件、COS 客户端与受控 HTTP 协议、tarball 消费 |
| 单次发布副作用 | 输入指纹、持久占位、接受/未知/拒绝、有限执行 | 原子持久 journal、真实 backend execute/observe/close | 多种适配与实际 CAS 冲突、防重放回归 |
| 命令适配 | 显式 CommandRunner、替换环境、输出上限、受管作用域、仅产生 accepted | 显式 OS Provider、固定 CLI/版本、私有配置和真实回读 | 支持宿主上的真实 Node 命令与作用域；以当轮结果为准 |
| 静态部署、OCI 镜像与运行部署 | 共享上述机制，分别留证 | 各协议适配仍由拥有真实需求的消费侧维护 | 自包含 HTTP/OCI 协议子集 fixture；不是厂商或云端认证 |
| 业务登记、授权、签名、迁移及业务验收 | 不提供业务实现 | 消费者在所有前提事实确认后执行 | 不据公共测试宣称业务上线 |

Pages、OCI registry、运行服务不能伪装成对象 PUT 或 CAS。只有一个消费者需要的厂商适配不满足 Foundation 准入规则；本版没有新增 Pages、OCI 或运行服务 Provider，也不更换消费者托管平台。`forge-release-vercel` 网站发布入口不受本能力替代。

## 输入与真实性

`ArtifactOperationIntent` 包含：

- `requestId`：1–128 位 ASCII 标识，首位为字母或数字，其后允许点、横线、下划线；同一持久 journal 的稳定键。
- `sourceCommit`：完整小写 Git SHA，40 或 64 位。
- `target`：显式 provider、namespace、HTTP(S) origin；不允许 URL 凭据、查询参数或路径。
- `capability`：`artifact-upload`、`deployment-create`、`deployment-ready` 或 `activation`，每个记录只描述一个明确事实。
- `configurationSha256`：配置及适配版本的 64 位小写 SHA-256。
- `inputs`：1–1024 个名称唯一的 `{ name, sha256, byteLength }`。名称最多 256 位，允许 ASCII 字母、数字、点、横线、下划线和斜线；长度为非负安全整数，总和也必须为安全整数。

`bindArtifactOperation` 对 target、配置、来源及按名称排序的输入生成确定性 fingerprint，并冻结快照。执行时重新核对 fingerprint、target、capability 和适配配置；恢复时还须与 journal 中的完整 binding 相同。`requestId` 不应含凭据或业务敏感数据。

指纹只绑定声明，不证明 Git 清洁、构建来源、发布权限或远端实际字节。消费者使用源码快照、构建证明、`artifact-integrity` 或原有 `publishArtifactFiles` 验证输入。适配器必须从可信远端接口验证不可变身份、目标、来源和摘要，不能只信自填 metadata、标签字符串或 fingerprint 回显。后端无法证明时返回 `unknown`。

## 持久占位与防重放

消费者实现 `ArtifactOperationJournal`：`load(requestId, context)` 返回完整记录或 undefined；`compareAndSet({ expectedRevision, next }, context)` 必须原子比较同一 requestId 的 revision，不存在视为 0，成功持久化才返回 `stored`，已知冲突返回 `conflict`。存储失败或结果未知须抛错，不得猜测成功。调用须支持 AbortSignal、有限 I/O 和可信持久化。

1. `performArtifactOperation` 读取并核验 binding；已有记录一律报 `RECOVERY_REQUIRED`。
2. CAS 0→1 持久化 `writeState: unknown`、`observation: unknown`，只有明确成功后才调用 execute。
3. execute 明确返回 `accepted` 后保存应答；返回 `rejected` 时保存稳定拒绝 code，停止观察。异常、超时、取消或无效响应都不能证明没有副作用。
4. observe 独立核对远端事实。`succeeded` 必须有非空、稳定的 reference；已知 reference 不允许变成另一个资源。观察后再次 CAS，不能覆盖其他观察者的新记录。
5. 关闭本次 transport。执行、观察、持久化和关闭分别留证；关闭失败不能改变远端状态。

CAS 只协调同一个 requestId。不同 requestId、不同 journal 或绕过 journal 的写入不被协调。跨请求的目标锁、CI 串行、数据库租约、激活竞争和权限验证仍由消费者负责。没有相应证明不能声称不存在竞争；本地锁不构成跨机器协调。

`observeArtifactOperation` 必须读取已有记录，绝不调用 execute。即使观察结果为 absent、failed 或 unknown，也不会自动重发、换 Provider 或回滚。新一次尝试须由消费者在协调范围内明确决定并使用新的 requestId。不要删除未知占位来解锁发布。

恢复入口只要求 `ArtifactOperationObserver`：target、capability、原操作的 configurationSha256、observe 和 close，无须实现 execute。完整 Transport 扩展此只读契约。换宿主或观察凭据时，可显式建立新的只读观察适配；仍核对原 binding，并真实验证同一远端资源，不能把配置摘要回显当成来源证明或借恢复更改执行配置。

## 回执与错误

`ArtifactOperationReceipt` 的独立维度：

| 字段 | 含义 |
| --- | --- |
| `record.writeState` | unknown、accepted 或 rejected；accepted 只证明应答接受 |
| `record.observation` | absent、pending、succeeded、failed 或 unknown；反映本次真实观察 |
| `record.reference` | 最多 512 位非空可打印 ASCII，不放秘密；绑定精确远端资源 |
| `record.attemptFailure` | 已记录的初次执行失败，后续观察成功也保留 |
| `journalState` | confirmed 表示回执记录已经确认持久化；unknown 表示尝试保存但结果未确认 |
| `closure` | closed/0 才确认本地资源关闭；unconfirmed 或 null 不可当作排空 |
| `outcome` | succeeded、pending、failed 或 unknown；只有真实观察和关闭均通过才可能成功 |

Provider 明确拒绝、记录已持久化且关闭确认时，异常回执的 outcome 为 failed；响应丢失等未确认副作用仍为 unknown，不能混作拒绝。

`journalState: unknown` 时，receipt.record 是尝试保存的记录，不能当作存储最终版本。应重新 load 并核对。占位应答丢失时也提供这类回执，且不执行副作用。

稳定错误包括 `INVALID_BINDING`、`INVALID_OPTIONS`、`INVALID_JOURNAL`、`INVALID_RESPONSE`、`TARGET_MISMATCH`、`BINDING_MISMATCH`、`CAPABILITY_UNSUPPORTED`、`JOURNAL_UNKNOWN`、`JOURNAL_CONFLICT`、`RECOVERY_REQUIRED`、`OPERATION_MISSING`、`PROVIDER_FAILED`、`PROVIDER_REJECTED`、`OBSERVATION_MISMATCH`、`OPERATION_ABORTED`、`BUDGET_EXCEEDED`、`CLOSURE_UNCONFIRMED` 及 transport 复用错误。异常只含结构化 code、receipt 和 closure，不保留原始异常、命令输出或凭据。

执行失败后会在剩余预算允许时保存 `attemptFailure`；预算到期或存储状态未知时不再启动额外写入。此时初始 unknown 占位仍阻止重放，但原始首错可能只存在于返回给调用方的异常中，消费方应保存该异常的结构化回执。

## 命令适配

```ts
import { createCommandArtifactOperation } from '@openge/forge-artifact-publish/node';
import { bindArtifactOperation, performArtifactOperation } from '@openge/forge-artifact-publish';

const adapter = await createCommandArtifactOperation({
  target, capability: 'deployment-create', runner: explicitOwnedCommandRunner,
  command: {
    command: absoluteNodeExecutable,
    args: [absolutePinnedCliEntry, ...providerArguments],
    cwd: absolutePrivateWorkDirectory,
    environment: explicitChildEnvironment,
  },
  maxOutputBytesPerStream: 256 * 1024,
  observationKey: 'static-observer-v1',
  observation: explicitRemoteObserver,
});
const binding = await bindArtifactOperation({ requestId, sourceCommit, target,
  capability: adapter.capability, configurationSha256: adapter.configurationSha256,
  inputs: verifiedInputDescriptors });
const receipt = await performArtifactOperation(adapter, binding, durableJournal, {
  timeoutMilliseconds: 300_000, closeTimeoutMilliseconds: 5_000, signal,
});
```

runner 必须由消费者显式配置真实 owned scope Provider；不支持时拒绝，不降级为普通 PID 观察。绝对可执行文件和 cwd、参数、按键排序的替换环境、输出策略与 observationKey 均进入配置指纹。参数/环境实际值不进入回执；低熵秘密的摘要仍应按敏感信息保护，不公开持久 journal。

输出上限为每流 1–16 MiB，超限采用 fail，不允许截断后判成功。实际命令接收三个公开关联环境变量：`FORGE_ARTIFACT_REQUEST_ID`、`FORGE_ARTIFACT_FINGERPRINT`、`FORGE_ARTIFACT_SOURCE_COMMIT`。命令本身必须使用私有目录和显式配置，不能回写真实用户的工具配置；替换环境及受管作用域不构成文件系统安全沙箱。

退出 0、无诊断/截断且 fingerprint 对应的作用域以 normal/closed/empty 关闭，才能产生 accepted。CLI 失败一律保留 unknown，不能据退出码猜测厂商已拒绝。显式 observation adapter 实现真实回读与 close，observationKey 随其验证语义或配置变化。适配器会关闭观察资源，且不向上返回捕获输出。

两个 timeout 都是 1–2,147,483,647 ms 的整数。总预算覆盖输入校验、journal 和 backend；关闭使用独立预算，只收敛已经启动的资源。不协作的请求可在函数返回后仍未完成，因此 closure 必须保留 unconfirmed，绝不据本地调用结束宣称云端结束。

## 两类消费方迁移

不可变目录发布者继续使用 `publishArtifactFiles` 与显式 COS transport，保留文件闭包、字节核验和外部协调。需要防止登记/激活请求被重复派发时，为那个明确副作用建立稳定 requestId、绑定已验证摘要和实际目标，提供真实 journal 与观察适配。恢复只读准确远端运行或 current 字节，不再次调用激活 API。签名目录合并、业务准入和信任策略留在消费者。

多制品发布者保留既有 Pages Direct Upload、OCI 构建/推送及运行服务实现。分别以不同 requestId 和 capability 接入操作机制；固定 CLI 和适配版本，显式 runner/credentials/private config，观察不可变部署身份、manifest/blob 摘要及精确运行部署。镜像 assembled、上传 accepted、部署 ready 和业务 registered 必须使用各自证据。将共性的超时、取消、unknown 处理、占位和防重放换为公共 SDK 后，业务锁、授权、限额、配置、登记、冻结与验收仍保留原归属。

上线前消费方须验收：源码/输入/目标变化拒绝；无效摘要和远端字节停止；响应丢失后不重放；同请求并发只执行一次；不同请求仍受业务协调；激活前后实际回读；CLI 输出上限、取消和资源关闭；凭据不落日志；静态/镜像/运行证据分别匹配；真实云权限、限额、网络与业务验收通过。

本仓库不持有消费者云凭据，不创建真实部署或业务数据。协议服务和真实 tarball 消费只证明本能力的公开契约、协议子集及本地资源生命周期；不能替代厂商 CLI、真实云端和消费方业务验收。

## 协议参考与包验证

[Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)、[Wrangler Pages 命令](https://developers.cloudflare.com/workers/wrangler/commands/pages/)、[OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md) 和 [crane digest](https://github.com/google/go-containerregistry/blob/main/cmd/crane/doc/crane_digest.md) 分别定义部署、CLI 与 blob/manifest 语义；本包不声称覆盖这些协议的全部实现。

`package-consumer` 的两类 fixture 从真实 tarball 安装公开包。目录场景由 COS Provider 包拥有；多制品场景由 Core 包拥有，调用真正的 Node CLI 和显式 owned scope Provider，并回读 blob、manifest、静态字节和运行状态。类型 fixture 仅从消费目录解析打包后的公开声明；TypeScript 编译器使用仓库现有工具。所有运行资源由测试创建，处于 ignored `.tmp/` 下并按生命周期关闭/清理。
