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

Observer 同步执行；普通命令的 observer 异常转成有界 diagnostic。启用 owned scope 时 observer 异常还会取消作用域，避免启动门观察者失败后继续放行。异步队列、backpressure、日志持久化和 UI 呈现由消费者负责。

### owned scope 与持久化启动门

Node 选项显式注入 Core 的 `ownedScopeProvider`，本包不导入或选择 Node Provider。spec 设置 `ownedScope: { start: 'automatic' | 'manual', binding }`；binding 是 1–256 个可见 ASCII 字符。缺 Provider、非 force 策略、不合法 binding、manual 无有限 timeout、run+manual 都在真实 argv 前拒绝。

manual 使用 start()。runner 先获取 helper 身份、调用 bind，再发送 scope-ready（scopeId/binding/identity）；调用方完成持久化和所有权检查后，调用 `running.authorizeStart()`。并发重复放行幂等；取消、超时、身份失败或结束之后不能恢复授权。automatic 在 bind 与事件交付成功后放行。

timeout 从 scope 启动计时，覆盖手动等待和关闭；输出捕获、上限和事件沿用普通命令实现。清理使用独立的有限预算，结果的 ownedScope 保存完整关闭事实。unknown 一律为 termination-failure，并保留 COMMAND_SCOPE_UNSUPPORTED/FAILED/UNKNOWN 诊断；不会按直接 child 的 exit0 判成功。浏览器根入口仍只有契约。

本包没有同步命令 API、shell execution、全局 SIGINT/SIGTERM handler、service supervision、readiness probe、restart、服务依赖图、端口归属规则或浏览器启动逻辑。

## 与其他 Foundation Forge 包的关系

进程身份和终止 contract 来自 [`forge-process-control`](process-control.md)。实际 Windows/Posix Provider 可使用 [`forge-process-control-node`](process-control-node.md)，但本包不会直接依赖或自动选择它。
