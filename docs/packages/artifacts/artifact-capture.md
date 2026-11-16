# 制品原始字节捕获与复核

`@openge/forge-artifact-publish/node` 的 `captureArtifactFiles` 与 `verifyArtifactFiles` 从调用方显式控制的普通文件获得独立内存快照，不调用存储、Git、部署工具或业务代码。不进行文本解码、换行归一化、源码执行或凭据发现。

## 输入与组合

```ts
import { captureArtifactFiles, verifyArtifactFiles } from '@openge/forge-artifact-publish/node';
import type { ArtifactFileCaptureOptions } from '@openge/forge-artifact-publish/node';

const options: ArtifactFileCaptureOptions = {
  sources: [
    { rootDirectory: absoluteRuntimeRoot, closure: 'exact', files: [
      { sourcePath: 'app.mjs', path: 'server/app.mjs', role: 'control' },
    ] },
    { rootDirectory: absoluteUiRoot, closure: 'exact', files: [
      { sourcePath: 'index.html', path: 'ui/index.html', role: 'asset',
        responseHeaders: { 'content-type': 'text/html', 'cache-control': 'no-cache' } },
    ] },
  ],
  pathCaseSensitivity: 'case-sensitive',
  maxFiles: 1000,
  maxEntries: 10000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  timeoutMilliseconds: 30000,
  signal,
};
const captured = await captureArtifactFiles(options);
const payload = captured.readFile('server/app.mjs');
const verified = await verifyArtifactFiles({ ...options,
  manifestBytes: captured.manifestBytes, expectedContent: captured.content });
```

每个 source 的 root 必须绝对、唯一且路径祖先不含符号链接或 junction；不静默替换 root 为链接目标。sourcePath 是该 root 下的便携相对路径，path 是最终清单逻辑路径，两者均最多 1024 UTF-8 字节。可直接组合多个已有目录，不另建整套磁盘 staging。源文件集合及响应策略在首次异步推进前复制；相同逻辑文件集合与策略产生相同身份，不依赖输入排列或 root 的物理位置。

role 与响应头沿用[内容清单 v1](artifact-content.md)：asset 显式包含 Content-Type、Cache-Control；control 不带响应头。源路径、逻辑路径分别拒绝重复及文件/祖先冲突。case-insensitive 还拒绝不同大小写的文件别名和共同目录别名；case-sensitive 允许实际区分大小写的不同路径。所有 source 之间仍拒绝 realpath 相同的实际源文件别名，不用声明的 case 语义覆盖文件系统实际行为。

## 闭包与读取

- closure: exact 在读取前后枚举 root；实际普通文件集合必须恰好等于 sourcePath 集合。允许无负载的空目录及嵌套空目录，但仍实际遍历每个目录，目录内任何未声明文件、符号链接或其他文件类型均拒绝；便携路径、大小写别名和目录身份守卫照常执行。所有目录及文件条目都计入前后两次扫描累计的 maxEntries。空目录不进入清单、负载字节数或内容身份。每个 root 独立核对，不把逻辑 path 当作物理路径。
- closure: declared 只读取声明文件，允许未声明的兄弟条目；不枚举或认证整个目录。单文件读取应显式选择此模式。

实际读取在分配前检查大小，通过受控路径与打开句柄确认普通文件身份，分块读取并多读至多一个字节检查增长；比较设备、inode、大小、纳秒 mtime/ctime、mode、nlink 的前后戳，关闭后及操作结束前重新核对路径身份。只读时间戳 atime 不进入身份。硬链接作为普通文件处理，不能由此推断其他名字或写者已隔离。

调用方须控制 root 及祖先命名空间，并停止或协调捕获期间的源写入。这些核对不提供跨文件原子瞬间、OS 沙箱、锁、签名或持久不可变目录；不能抵御不可信进程反复替换祖先或特权写者。磁盘后续变化不会改变成功返回的内存快照。

## 结果与预算

CapturedArtifactFiles 的 manifest、content 和描述符被冻结；私有原始字节不暴露。manifestBytes 每次返回新副本，readFile(path) 返回相应逻辑文件的新副本，不重读磁盘；未知路径抛 INVALID_SOURCE。payloadByteLength 仅计负载，清单不包含自身。副本可由调用方修改，但不会改变内部字节、身份或下一次读取。内存由快照生命周期与调用方持有的副本决定，没有后台任务或磁盘保留槽。

所有数量/字节/时间上限均为必需的有限正安全整数。maxFiles 不超过 10000，maxManifestBytes 不超过 1 MiB，timeoutMilliseconds 不超过 2147483647，maxFileBytes 小于当前 Node Buffer 长度上限。maxFiles 限制所有 source 的声明文件总数；maxEntries 限制所有 exact 前后扫描累计访问的文件和目录条目；declared 不遍历兄弟目录。maxFileBytes 限单文件实际字节；maxTotalBytes 限总负载加最终规范清单。空文件合法。

这些是逻辑输入预算，不是进程 RSS 或操作系统 I/O 硬限额；读取缓冲、摘要和调用方副本可能增加内存峰值。一个截止时间覆盖验证、枚举、读取、摘要与最终检查，signal 取消产生结构化错误。不可取消的 OS 文件操作与句柄关闭仍须等待返回；不在后台丢弃文件操作以伪称已释放资源。

## 复核与错误

verifyArtifactFiles 接收同一 source 映射/策略、真实 manifestBytes 和 expectedContent。先复制并验证清单：必须符合现有 schema、实际字节已经规范化且 SHA-256 与 expectedContent 一致；再捕获真实文件，核对内容身份。换序 JSON、BOM、额外换行、策略差异、同长负载改写均不能凭可解析绕过核对。复核仍返回私有快照，不执行负载。

错误使用 ArtifactPublicationError：非法计划/清单为 INVALID_PLAN，非法限额为 INVALID_OPTIONS，逃逸、链接、非普通文件或闭包不符为 INVALID_SOURCE，身份/字节/规范编码变化为 INTEGRITY_MISMATCH，操作超时/资源超限为 BUDGET_EXCEEDED，取消为 OPERATION_ABORTED，关闭未确认则为 CLOSURE_UNCONFIRMED。无远端副作用或发布收据，不附原始路径、凭据与 cause。清单内部一致不等于受信生产者、业务授权或构建可复现性。
