# `@openge/forge-workspace-checks`

针对中立 workspace dependency graph 的纯逻辑、确定性检查框架。

## 什么时候使用

适合已经拥有 `WorkspaceGraph`，希望组合多个规则并获得稳定结构化诊断，而不让规则层读取文件系统或绑定包管理器的场景。

## 安装

```sh
pnpm add -D @openge/forge-workspace-checks
```

## 可用入口

- `@openge/forge-workspace-checks`：唯一入口，纯逻辑。

## 核心能力

- `runWorkspaceChecks`：对同一个 graph 依次执行一组检查并汇总稳定报告。
- `createPackageCycleCheck`：内置 package dependency cycle 检查。
- `WorkspaceCheck` contract：允许上层创建其它领域中立检查。
- `WorkspaceChecksError` 与稳定错误码。

## 快速使用

```ts
import { createPackageCycleCheck, runWorkspaceChecks } from '@openge/forge-workspace-checks';

const report = runWorkspaceChecks(graph, [createPackageCycleCheck()]);
```

## 行为与限制

本包不读取 workspace 文件、不选择包管理器、不运行命令，也不把发布或业务流程语义塞进检查结果。规则只消费调用方提供的中立图。

## 与其他 Foundation Forge 包的关系

图 contract 来自 [`forge-workspace-graph`](workspace-graph.md)。需要自动读取 pnpm workspace 并提供 CLI 时，使用 [`forge-workspace-checks-pnpm`](workspace-checks-pnpm.md)；pnpm 文件读取仍由 [`forge-workspace-pnpm`](workspace-pnpm.md) 独立负责。
