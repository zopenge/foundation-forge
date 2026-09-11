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
- 返回带稳定 start token 的进程身份，以及可获得的名称、命令路径、命令行和 parent PID。
- 终止前重新校验 PID/start token；支持单进程与进程树终止。

## 快速使用

```ts
import { createWindowsProcessControl } from '@openge/forge-process-control-node';

const processes = createWindowsProcessControl({ listenerBackend: 'powershell' });
const running = await processes.listProcesses();
const listeners = await processes.listTcpListeners({ ports: [3000] });
```

## 行为与限制

Provider 不自动检测平台、不在 backend 失败后隐式切换方案。Windows 进程树终止使用 `taskkill /T`；Posix 树终止针对 PID 对应的 process group，因此调用方必须确保自己拥有并正确启动该进程组。

系统命令不存在或执行失败会按 Core 错误 contract 返回，不由本包转换成产品恢复流程。

## 与其他 Foundation Forge 包的关系

contract 与错误语义来自 [`forge-process-control`](process-control.md)。需要“启动命令 + 输出限制 + timeout/cancel + 终止”的完整生命周期时，使用 [`forge-command-runner`](command-runner.md) 并把本 Provider 注入给它。
