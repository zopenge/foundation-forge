# `@openge/forge-process-control-node`

为 `forge-process-control` 提供显式 Windows 和 Posix Node.js Provider。

## 什么时候使用

适合 Node.js 工具需要实际枚举进程、查询 TCP listener 或按 Core contract 终止进程/进程树，并且愿意明确选择平台和后端的场景。

## 安装

```sh
pnpm add @openge/forge-process-control @openge/forge-process-control-node
```

## 可用入口

- `@openge/forge-process-control-node`：唯一入口，导出 Windows/Posix Provider factory。

## 核心能力

- `createWindowsProcessControl`：显式选择 `powershell` 或 `netstat` listener backend。
- `createPosixProcessControl`：显式使用 `lsof` 后端。
- `createWindowsProcessIdentityReader`、`createPosixProcessIdentityReader`：独立的只读身份工厂，不要求配置 listener backend。
- 返回带稳定 start token 的进程身份，以及可获得的名称、命令路径、命令行和 parent PID。
- 终止前重新校验 PID/start token；支持单进程与进程树终止。

## 快速使用

```ts
import { createWindowsProcessControl } from '@openge/forge-process-control-node';

const processes = createWindowsProcessControl({ listenerBackend: 'powershell' });
const running = await processes.listProcesses();
const listeners = await processes.listTcpListeners({ ports: [3000] });
```

仅查询身份时，组合层显式选择平台工厂，业务层只依赖 Core 的 `ProcessIdentityReader`：

```ts
import type { ProcessIdentityReader } from '@openge/forge-process-control';
import { createWindowsProcessIdentityReader } from '@openge/forge-process-control-node';

const reader: ProcessIdentityReader = createWindowsProcessIdentityReader();
const result = await reader.readIdentity({ pid: 42 });
if (result.status === 'FOUND') {
  const { pid, startToken } = result.identity;
}
```

POSIX 组合层使用 `createPosixProcessIdentityReader()`。两个工厂均接受 `ProcessIdentityReaderOptions`，可通过 `runner?: ProcessCommandRunner` 注入已获授权的传输；省略时沿用本包已有命令执行器，创建 reader 本身不执行查询。

Windows 身份 reader 使用 .NET `Process.GetProcessById` 读取目标 PID 的真实 `StartTime`，由 Console 输出 JSON，不加载 PowerShell cmdlet 模块；创建时间按 UTC 毫秒编码为既有 CIM JSON 的 `/Date(毫秒)/` token，保持与完整查询的 token 比较语义。仅明确的进程不存在返回空结果；访问拒绝、其他系统异常和取消仍拒绝，不重试或切换来源。POSIX reader 仍使用 `ps`，只查询 `pid` 和 `lstart`。完整 Windows 进程描述与终止接口继续使用原后端，本次没有将其改为另一套实现。

只有成功且为空的查询结果（以及 POSIX `ps` 无匹配时退出码为 1、标准输出和错误输出均为空的结果）返回 `ABSENT`。权限诊断、失败退出、无效或缺失 token、非目标 PID 或歧义记录均拒绝；取消请求使用 `OPERATION_ABORTED`。完整的进程描述查询和终止接口保持原有行为。

## 行为与限制

### 显式 owned scope

`createWindowsOwnedProcessScopeProvider()` 面向 Windows x64：建立未命名 Job Object，开启 kill-on-close、禁止 breakaway，以真实进程句柄校验 helper 身份并加入 Job。正常关闭读取内核 active process accounting；直接作业 close 后确认仍有存活后代就立即终止自己的 Job，并返回 unknown。退出时 accounting、成员表和进程对象触发时机可能不同；只有完整成员表，或已验证属于该 Job 的稳定句柄及原生终止状态证明成员已终止，才允许有界等待统计同步。句柄未触发时使用 GetExitCodeProcess 区分已退出与 STILL_ACTIVE；仍活动的成员没有等待宽限。成员已删除时必须重新取得完整 root-only Job 表；不以 PID 查询缺失或进程名称作为关闭证明，权限、归属、句柄和不完整查询错误仍返回 unknown。

`createLinuxOwnedProcessScopeProvider()` 面向 Linux/glibc x64，要求 glibc 的 prctl、waitpid、pidfd_open、pidfd_send_signal 和支持它们的内核。独立 helper 先设置并读回 subreaper，直接 child 先由 libuv 回收，再 wait/reap 额外后代；只有 ECHILD 证明空树。异常清理仅使用自己的孩子、复核 PPid 和稳定 pidfd。协调进程不设置 subreaper；helper 消失不能补造关闭证明。

两个工厂均不接受任意 helper/native 路径，缺少能力或 Job 绑定失败在真实 argv 前拒绝，无普通 spawn/轮询回退。首版 owned terminate 只接受 force；完整旧 Provider 的终止策略保持原契约。scopeId/binding/nonce/序号绑定私有 IPC，launch 最多 1 MiB、control 最多 64 KiB；stdout/stderr 单独交付。helper 不执行 NODE_OPTIONS/NODE_PATH/动态加载器预加载，真实作业在授权后接收声明环境。

Koffi 精确固定 3.3.3，只从已安装依赖懒加载预编译制品。本仓和真实 tarball 消费安装配置 `allowBuilds.koffi: false`；其他 pnpm 消费方也应配置此项以禁止其安装脚本编译回退。运行时缺 prebuild 明确失败，不下载、不编译、不提权。支持范围不是 Koffi 的完整平台列表。

Job/subreaper 是受信任命令的归属边界，不是安全沙箱。命令不得通过 WMI、系统服务等外部进程所有者代办作业。操作系统强杀 helper、IPC 失效或观测不完整都可能留下 unknown，调用方须保留恢复证据；“清理后空树”不等于“正常关闭”。

Provider 不自动检测平台、不在 backend 失败后隐式切换方案。Windows 进程树终止使用 `taskkill /T`；Posix 树终止针对 PID 对应的 process group，因此调用方必须确保自己拥有并正确启动该进程组。

系统命令不存在或执行失败会按 Core 错误 contract 返回，不由本包转换成产品恢复流程。

## 与其他 Foundation Forge 包的关系

contract 与错误语义来自 [`forge-process-control`](process-control.md)。需要“启动命令 + 输出限制 + timeout/cancel + 终止”的完整生命周期时，使用 [`forge-command-runner`](command-runner.md) 并把本 Provider 注入给它。
