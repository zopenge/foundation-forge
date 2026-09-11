# `@openge/forge-command-runner`

领域中立的异步命令 contract，加上显式 Node.js adapter；负责单个 child process 的启动、输出交付、捕获上限、timeout/cancel 和受控终止生命周期。

## 什么时候使用

适合开发工具、外部工具调用或服务脚本需要安全执行一个可执行文件，同时明确限制输出、时间和终止预算，并希望把进程树发现/终止委托给可注入 Provider 的场景。

它不是 shell、任务编排器或 service supervisor。

## 安装

```sh
pnpm add @openge/forge-command-runner @openge/forge-process-control
```

实际运行时还需要调用方提供 `ProcessControlProvider`；Node 应用通常可选择 `@openge/forge-process-control-node`。

## 可用入口

- `@openge/forge-command-runner`：纯 `CommandSpec`、result/event/error contract 与 `normalizeCommandSpec`。
- `@openge/forge-command-runner/node`：`createNodeCommandRunner` 和 Node adapter 选项。

## 核心能力

- `normalizeCommandSpec`：同步验证并冻结命令、参数、环境和输出设置。
- `createNodeCommandRunner`：创建显式平台、Provider 和终止预算的 runner。
- `run()`：执行一次命令并返回结构化结果。
- `start()`：暴露 `pid`、`identity`、`result` promise 与幂等 `terminate()`。
- 输出策略：`events`、`capture`、`ignore`；capture 支持 truncate 或 overflow 触发终止。

## 快速使用

```ts
import process from 'node:process';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';

const runner = createNodeCommandRunner({
  platform: 'win32',
  processControl,
  terminationPolicy: { mode: 'force' },
  identityAcquisition: { timeoutMs: 2_000, pollIntervalMs: 20 },
  terminationTimeoutMs: 5_000,
});

const result = await runner.run({
  command: process.execPath,
  args: ['--version'],
  environment: { mode: 'inherit' },
  output: { mode: 'capture', maxBytesPerStream: 16_384, overflow: 'truncate' },
  timeoutMs: 10_000,
});
```

`command` 与 `args` 分离，并以 `shell: false` 直接交给 Node spawn；本包不会解析命令字符串或自动启用 shell。

## 生命周期与限制

Runner 在 spawn 后通过注入的 Provider 获取稳定进程身份；无法在预算内识别仍存活的 child 时返回 `COMMAND_IDENTITY_UNAVAILABLE`，不会把裸 PID 交给进程树终止。timeout、AbortSignal、手动 terminate 和 output overflow 共用同一终止流程。

`terminationTimeoutMs` 是完整终止管理预算，还用于约束进程退出后继承 pipe 的关闭等待。Provider 不响应或 descendant 长期保持 pipe 打开时，会以结构化 `termination-failure` 收口，而不是无限等待。

Observer 同步执行；observer 异常转成有界 diagnostic，不中断命令生命周期。异步队列、backpressure、日志持久化和 UI 呈现由消费者负责。

本包没有同步命令 API、shell execution、全局 SIGINT/SIGTERM handler、service supervision、readiness probe、restart、服务依赖图、端口归属规则或浏览器启动逻辑。

## 与其他 Foundation Forge 包的关系

进程身份和终止 contract 来自 [`forge-process-control`](process-control.md)。实际 Windows/Posix Provider 可使用 [`forge-process-control-node`](process-control-node.md)，但本包不会直接依赖或自动选择它。
