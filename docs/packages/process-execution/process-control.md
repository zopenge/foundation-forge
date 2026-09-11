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
- `ProcessDescriptor`、`TcpListener` 与进程/监听查询 contract。
- 单进程和进程树终止 request、policy、result contract。
- `ProcessControlProvider`：由平台实现提供发现和终止能力。
- `selectTcpListeners`：对监听项做确定性筛选。

## 快速使用

```ts
import { selectTcpListeners } from '@openge/forge-process-control';

const selected = selectTcpListeners(discoveredListeners, { ports: [3000, 5173] });
```

## 行为与限制

本包不执行任何操作系统 I/O，也不负责进程启动、服务归属、平台选择、恢复策略、日志或用户文案。

## 与其他 Foundation Forge 包的关系

实际 Windows/Posix 实现见 [`forge-process-control-node`](process-control-node.md)。[`forge-command-runner`](command-runner.md) 依赖本包 contract，并由调用方注入 Provider，而不是直接绑定 Node Provider。
