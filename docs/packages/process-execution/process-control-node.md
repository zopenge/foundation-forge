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

Provider 不自动检测平台、不在 backend 失败后隐式切换方案。Windows 进程树终止使用 `taskkill /T`；Posix 树终止针对 PID 对应的 process group，因此调用方必须确保自己拥有并正确启动该进程组。

系统命令不存在或执行失败会按 Core 错误 contract 返回，不由本包转换成产品恢复流程。

## 与其他 Foundation Forge 包的关系

contract 与错误语义来自 [`forge-process-control`](process-control.md)。需要“启动命令 + 输出限制 + timeout/cancel + 终止”的完整生命周期时，使用 [`forge-command-runner`](command-runner.md) 并把本 Provider 注入给它。
