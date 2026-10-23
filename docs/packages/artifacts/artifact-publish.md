# `@openge/forge-artifact-publish`

中立的不可变对象发布、回读验证、最后切换指针和已有版本激活编排。适合独立制品生产者、静态资源发布器和目录发布器；对象内容与指针格式由消费者拥有。

## 入口与契约

| 入口 | 公开能力 |
| --- | --- |
| `@openge/forge-artifact-publish` | `publishArtifactRelease`、`activateArtifactRelease`、公开契约和 `ArtifactPublicationError`；不导入 Node 模块 |
| `@openge/forge-artifact-publish/node` | `publishArtifactFiles`、文件计划类型；browser 条件拒绝导入 |

`ArtifactObjectDescriptor` 包含 `key`、`byteLength`、`sha256`、`contentType`、`cacheControl`。SHA-256 是不带前缀的 64 位十六进制；收据规范化为小写。发布计划为每个对象追加 `Uint8Array bytes`；文件计划追加便携相对 `path`。所有计划还需完整小写 Git SHA（40 或 64 位）`sourceCommit`、以 `/` 结尾的 `immutablePrefix`、带字节的小型 `pointer`。

对象键必须属于该不可变前缀，不能重复；指针必须位于前缀之外。字节、描述符和选项在异步推进前快照；所有本地字节先校验，再调用存储。`sourceCommit` 是调用方声明，库不查 Git、不证明构建来源或签名身份。

## 调用与阶段

```ts
import { publishArtifactRelease, activateArtifactRelease } from '@openge/forge-artifact-publish';
import { publishArtifactFiles } from '@openge/forge-artifact-publish/node';

const options = {
  concurrency: 4,
  timeoutMilliseconds: 600_000,
  closeTimeoutMilliseconds: 5_000,
  maxObjectBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxPointerBytes: 64 * 1024,
  concurrencyControl: { mode: 'external-serialization' as const, scope: 'artifact-channel' },
  signal,
};
const receipt = await publishArtifactRelease(freshTransport, releasePlan, options);
// 每次操作使用新的 transport；已有对象激活不会重新上传不可变对象。
const rollback = await activateArtifactRelease(anotherTransport, activationPlan, options);
const fromFiles = await publishArtifactFiles(fileTransport, absoluteRoot, filePlan, {
  ...options, pathCaseSensitivity: 'case-sensitive',
});
```

1. 校验输入、限额和本地完整性；Provider 检查存储前提。
2. 在有限并发下执行不可变 create。已存在也必须 GET 实际字节，校验长度、SHA-256、Content-Type 和 Cache-Control；元数据不同即失败，不覆盖纠正。
3. 全部对象通过后才 replace 指针，再 GET 校验指针。
4. 关闭本次拥有的资源；只有验证和关闭都确认成功才返回成功收据。

`activateArtifactRelease` 使用已知摘要描述符，省略第 2 步的 create；缺对象、内容或元数据不符均停止，不能借回滚重写旧版本。并发 worker 首错停止新工作并取消已发请求，保留首错，不自动重试。

## 串行与信任边界

`concurrencyControl.mode` 只接受 `external-serialization`。消费者必须把同一指针的所有发布和回滚放到同一 CI 仓库的串行入口，或提供等价的外部串行协调。`scope` 只是收据中的声明，不是分布式锁、租约或目的对象 CAS；先读后写也不能代替协调。

签名、目录 schema、受信根、撤销、版本排序、制品选择以及某 SHA 属于哪个生产者均由消费侧负责。库不解析指针业务内容，不自动选择 Provider，不导入上层产品协议。

## 文件与资源边界

`publishArtifactFiles` 要求显式绝对根目录和路径大小写策略，拒绝 symlink/junction、非普通文件、越界、重复及大小写冲突。检查路径祖先、打开后的文件身份，最多读取声明长度加一个字节以发现增长；句柄关闭后才进入网络阶段。全部文件进入内存快照，无持久 staging 依赖。消费者需保证来源目录不会被不可信进程同时改写；这些检查不构成操作系统沙箱。

调用将一个全新的 transport 的资源所有权交给 Core，即便输入失败也关闭。并发复用返回 `TRANSPORT_IN_USE` 且不关闭首个操作的资源；后续复用返回 `TRANSPORT_CLOSED`。Provider 必须实现 create-only、受限读取、AbortSignal 和可信关闭反馈。

总预算覆盖文件准备与传输；独立关闭预算仅等待已启动资源收敛，不启动新传输。非协作 I/O 超过关闭预算后只能报告 `unconfirmed`；`activeRequests: null` 表示数量无法确认。关闭失败不能把已写入的对象或指针撤销。

## 必需限额

| 输入 | 规则 |
| --- | --- |
| `concurrency` | 整数 1–64 |
| 两个 timeout 字段 | 正整数，分别不超过 2,147,483,647 ms |
| `maxObjectBytes`、`maxTotalBytes` | 正安全整数；总量包含全部对象和指针的逻辑长度 |
| `maxPointerBytes` | 正整数，不超过 1 MiB |
| 对象数量、键 | 1–10,000 个；便携相对路径规则，键最多 1,024 UTF-8 字节 |
| 元数据、串行 scope | 元数据为非空可打印 ASCII，单值不超过 2,048 字符；scope 非空、无控制符且不超过 256 字符 |

逻辑字节上限不是网络流量或进程 RSS 上限。入口快照、文件缓冲、摘要实现、上传和并发回读均可能持有副本；应按可用内存主动设置更小限额。本版不提供流式上传或 multipart。Provider 可以有更小协议上限。

## 收据与错误

`ArtifactPublicationReceipt.schemaVersion = 1`，绑定 operation、target、sourceCommit、前缀、串行声明、所有精确描述符、pointer 和 closure。每个对象分别记录 `writeState`（`not-attempted` / `accepted` / `already-exists` / `unknown`）与 `verificationState`（`pending` / `succeeded` / `failed`）。失败时 `ArtifactPublicationError` 提供稳定 code、phase、可选 key/statusCode；已建立计划的失败附带 receipt，输入早期失败可能只有 closure。

`unknown` 不能解读为没有写入。尤其指针请求发出后连接断开或取消，远端可能已更新；在同一外部串行下核实远端状态，再决定续作。库不自动回滚，也不猜测成功。`accepted` 仅说明写入应答已接受，仍须查看 verification 与总 outcome。

收据不包含字节、文件绝对路径、凭据或原始异常 cause；不输出完整环境。调用方不要把秘密放进明确会记录的 key、scope 和 target 元数据。消费者自行决定收据的持久位置、访问权限与审计保存策略。

## 验证与依赖

Core 只依赖 [`artifact-integrity`](artifact-integrity.md) 与 [`path-safety`](path-safety.md)，[`artifact-publish-cos`](artifact-publish-cos.md) 单向依赖 Core。包内测试覆盖编排、预算、并发、真实普通文件及关闭；`package-consumer/verify.mjs` 从真实 tarball 导入公开入口、自建并清理 fixture，既有 `.tmp` 内容不是通过前提。完整仓库门禁为 `pnpm check`。
