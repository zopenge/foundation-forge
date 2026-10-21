# `@openge/forge-process-control`

领域中立的进程身份、TCP listener、终止策略和 Process Control Provider contract。

## 什么时候使用

适合需要统一描述“哪个进程”“哪个监听端口”“如何安全终止单进程或进程树”，但不希望 Core 直接调用操作系统命令的场景。

## 安装

```sh
pnpm add @openge/forge-process-control
```

## 可用入口

- `@openge/forge-process-control`：唯一入口，纯 contract 与确定性选择逻辑。

## 核心能力

- `ProcessIdentity`：用 PID 与稳定 start token 共同标识进程，降低 PID 复用误杀风险。
- `ProcessIdentityReader`：只读指定 PID 的身份，不要求进程描述、监听发现或终止能力。
- `ProcessDescriptor`、`TcpListener` 与进程/监听查询 contract。
- 单进程和进程树终止 request、policy、result contract。
- `ProcessControlProvider`：由平台实现提供发现和终止能力。
- `selectTcpListeners`：对监听项做确定性筛选。

## 快速使用

```ts
import { selectTcpListeners } from '@openge/forge-process-control';

const selected = selectTcpListeners(discoveredListeners, { ports: [3000, 5173] });
```

只需要身份的租约管理层或进程监测层可以依赖窄契约：

```ts
import type {
  ProcessIdentityReader,
  ReadProcessIdentityRequest,
  ReadProcessIdentityResult,
} from '@openge/forge-process-control';

function readIdentity(
  reader: ProcessIdentityReader,
  request: ReadProcessIdentityRequest,
): Promise<ReadProcessIdentityResult> {
  return reader.readIdentity(request);
}
```

`FOUND` 的 `identity` 仅包含 `pid`、`startToken`；`ABSENT` 表示查询已确认目标不存在。权限不足、查询失败、无效或缺失的 start token、无法解析或无法确认身份的结果均以 `ProcessControlError` 拒绝，调用方不能将这些拒绝转换为 `ABSENT`。start token 是来源相关的不透明值，比较时应使用同一合法来源，不应自行生成或推断。

## 行为与限制

本包不执行任何操作系统 I/O，也不负责进程启动、服务归属、平台选择、恢复策略、日志或用户文案。

## 与其他 Foundation Forge 包的关系

实际 Windows/Posix 实现见 [`forge-process-control-node`](process-control-node.md)。[`forge-command-runner`](command-runner.md) 依赖本包 contract，并由调用方注入 Provider，而不是直接绑定 Node Provider。
