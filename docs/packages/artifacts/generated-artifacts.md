# `@openge/forge-generated-artifacts`

用显式生成物计划描述预期文件，在纯逻辑层比较快照，并在 Node.js 中安全发布变更文件。

## 什么时候使用

适合代码生成器、索引生成、配置派生文件等“我明确知道应该有哪些文件及内容”的场景。它尤其适合需要稳定比较、保留未变化文件 mtime、拒绝危险路径并控制退休文件删除的工具链。

如果需要扫描整个目录、推断哪些文件过期或定义产品输出 schema，这些职责应留在消费者。

## 安装

```sh
pnpm add @openge/forge-generated-artifacts
```

## 可用入口

- `@openge/forge-generated-artifacts`：纯计划定义与快照比较，runtime-neutral。
- `@openge/forge-generated-artifacts/node`：文件系统检查与发布；browser condition 下不可用。

## 核心能力

- `defineGeneratedArtifactPlan`：声明 expected artifacts 与显式 retired paths。
- `compareGeneratedArtifactSnapshot`：返回 missing、stale、retiredPresent 等确定性结果。
- `inspectGeneratedArtifacts`：在显式绝对根目录下预检当前状态。
- `publishGeneratedArtifacts`：只写计划内文件，并删除计划内明确退休文件。

## 快速使用

```ts
import { defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import { publishGeneratedArtifacts } from '@openge/forge-generated-artifacts/node';

const plan = defineGeneratedArtifactPlan({
  artifacts: [{ path: 'generated/index.txt', content: 'ready\n' }],
  retiredPaths: ['generated/old.txt'],
});

const result = await publishGeneratedArtifacts('/absolute/project/root', plan, {
  pathCaseSensitivity: 'case-sensitive',
});
```

## 行为与限制

路径必须是安全的便携相对路径；调用方必须显式选择大小写策略。发布前会检查 expected/retired 的 file-ancestor 冲突，并拒绝目标或祖先 symlink/junction。变化文件先在目标目录写临时文件，再以 rename 发布；内容相同的文件不重写。

单文件发布是原子的，但整个 plan 不是跨文件事务；前面已经成功的写入不会因后续失败整体回滚。退休删除只处理显式列出的路径，不递归清理目录，也不扫描计划外文件。

`normalize-newlines` 只适用于字符串比较；它统一 CRLF/CR/LF，但不改变其它空白、BOM 或末尾换行是否存在。

## 与其他 Foundation Forge 包的关系

路径规则来自 [`forge-path-safety`](path-safety.md)。[`forge-repository-context`](../repository-tooling/repository-context.md) 可向下复用纯比较能力，但文件系统发布仍由本包 `/node` 负责。

## 需要持久确认的本地目录与字节文件

`/node` 另提供两个显式工厂，均返回 `Promise<DurableArtifactFilesystem>`：

- `createLinuxDurableArtifactFilesystem()`：仅 Linux x64；本地文件系统必须提供真实的文件和目录 `fsync` 语义。
- `createWindowsNtfsDurableArtifactFilesystem()`：仅 Windows x64、本地固定 NTFS 卷；原生依赖固定为 `koffi@3.3.3`，没有运行时构建、提权或其他文件系统降级。

两者不隐式选择 Provider。调用方在部署配置中选择适合自身目标的工厂；非目标平台均拒绝，Windows 还自动拒绝远程卷和非 NTFS 卷。Linux 的本地文件系统与真实 `fsync` 语义由部署方保证，适配不探测挂载的远程性。

```ts
import { createWindowsNtfsDurableArtifactFilesystem } from '@openge/forge-generated-artifacts/node';

const files = await createWindowsNtfsDurableArtifactFilesystem();
// 该绝对根须已持久存在，且由调用方控制其祖先命名空间。
const root = process.argv[2];
if (!root) throw new Error('PERSISTENT_ROOT_REQUIRED');
await files.ensureDirectory(root, 'state/frozen');
await files.publishBytes(root, 'state/frozen/content.bin', new Uint8Array([1, 2, 3]), {
  mode: 'exclusive',
});
await files.publishBytes(root, 'state/current.json', new TextEncoder().encode('{"version":2}\n'), {
  mode: 'replace',
});
```

`rootDirectory` 必须是已存在的绝对目录，相对路径采用包内便携路径规则。`ensureDirectory(rootDirectory, relativePath?)` 只创建声明的目录链；省略相对路径或传入空串时只检查并同步根目录，不创建任何额外条目。`publishBytes` 仍要求非空文件路径；它创建声明路径缺失的父目录后，在目标同目录中创建独占暂存文件。字节与 `mode` 在第一个异步操作前快照，后续调用方修改不能改变本次发布。文件创建模式为 `0600`、目录为 `0700`；Windows 的实际访问权限由父目录 ACL 定义，不能将 POSIX mode 数字当作 Windows 私密性证明。

成功返回前依次完成：

1. 同步根目录，逐层创建缺失目录，并同步子目录和对应父目录；已存在的目录也同步，以覆盖上次中断后的未确认目录项。
2. 写入同目录暂存文件，同步内容并确认其句柄关闭。
3. `exclusive` 使用 hard link 保证已有目标不会被覆盖；`replace` 使用同目录 rename 进行原子替换。
4. 重新打开已发布文件，用 BigInt 精确核对它仍是暂存时的文件身份，同步发布后的内容/元数据并关闭句柄；清除本次暂存名称后同步父目录，确认该目录句柄关闭。

Linux 使用目录描述符 `fsync`。Windows 使用 `CreateFileW` 的 `GENERIC_WRITE`、`FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT` 目录句柄，核对实际目录属性、本地固定卷和 NTFS，再执行 `FlushFileBuffers`、检查 `CloseHandle`。不吞掉 `ERROR_ACCESS_DENIED`，也不把非 NTFS 返回成功视为等价。

### 保证依据与适用前提

这是 OS/文件系统层面的内容与名称发布保证，前提是文件系统、驱动和存储遵守成功的 flush 请求；不证明硬件永不失效，也不提供跨文件事务。Linux 的文件 `fsync` 不单独保证父目录项，需要额外的目录 `fsync`，见 [Linux fsync 契约](https://man7.org/linux/man-pages/man2/fsync.2.html)。

Windows 的 [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) 描述目录句柄与缓存标志，[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) 定义写入句柄的缓冲刷新，[File Caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching) 说明元数据也须刷新。[MS-FSA §2.1.5.7](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/0de7dc40-9627-437e-a4df-c4696cdc3d02) 定义稳定存储及目录结构同步，[产品说明 note 80](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63) 将目录结构保证限定为 NTFS。本适配对本地 NTFS 的保证由这些 Win32 操作与文件系统语义组合得出；不将目录 API 示例列表当作禁止，也不以原生调用返回成功或普通进程重启代替物理掉电实验。

调用方须控制根、祖先目录和相关文件的写入/重命名权限，协调其他写入者。适配会拒绝可见 symlink/junction，Windows 还核对实际打开的目录；它不是针对恶意并发路径替换的沙箱。根及根以上的既有目录链由调用方保证已持久建立；`ensureDirectory(rootDirectory)` 只重新确认根内容中的目录项，不承诺根本身在其父目录中的名称绑定。不能将上次 unknown 创建后仍存在的子目录直接提升为持久根；应回到原已稳定的授权锚点，传入完整相对目录链逐层确认。外部新状态树同样须显式选择持久父锚，不能以逃逸后的 realpath 替代原可信根。本 API 不向授权根以外创建目录或同步整个卷。跨卷、网络文件系统、自动重试、权限修复和系统设置更改均不包含在内。

### 失败与恢复

- 已有独占目标返回 `GENERATED_ARTIFACT_DESTINATION_OCCUPIED`，保留原字节；若同时存在清理失败，仍须处理其 `details.cleanupFailed`。
- 不支持的宿主、原生依赖或 Windows 文件系统返回 `GENERATED_ARTIFACT_DURABILITY_UNSUPPORTED`。
- I/O、flush 或 close 未确认返回结构化错误，包含阶段及 `durability: 'unknown'`。`publishBytes` 的 `publication` 为 `not-published` 或 `unknown`；后者不能当作未发生。
- 发布后任何失败均保留目标，不用删除目标模拟回滚、不盲目重放；调用方检查真实字节和持久记录再决定恢复。只清理本次拥有的暂存名称，清理失败亦有诊断。

本 API 在尝试发布前已完成内容同步。若只在发布后的目录确认阶段中断，调用方协调写入者并核对目标字节/身份与自己的持久记录后，可用 `ensureDirectory(rootDirectory, parentRelativePath)` 重新确认目录项；文件在根目录直下时使用 `ensureDirectory(rootDirectory)`。该操作不重新发布文件，也不能替代其他来源文件尚未完成的内容同步。来源或字节仍未知时继续保留 unknown。

真实 tarball 消费者在独立 Node 进程中创建目录、独占发布、替换、退出，再用新进程读回，并让两个进程竞争同一独占目标。故障注入仅覆盖 OS/句柄失败边界；不冒充真实掉电验证。
