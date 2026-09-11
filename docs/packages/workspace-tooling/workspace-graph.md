# `@openge/forge-workspace-graph`

不依赖文件系统或包管理器的确定性 workspace package dependency graph Core。

## 什么时候使用

适合已经拿到 package 元数据，希望统一做依赖图构建、环检测、可达性分析或 dependency-first 排序的工具链。

如果输入来自 pnpm workspace，可用 `forge-workspace-pnpm` 把文件系统数据转换成本包 contract。

## 安装

```sh
pnpm add -D @openge/forge-workspace-graph
```

## 可用入口

- `@openge/forge-workspace-graph`：唯一入口，纯逻辑。

## 核心能力

- `createWorkspaceGraph`：从中立 package 列表创建图并诊断未解析 workspace dependency。
- `sortWorkspacePackages`：按指定 dependency kinds 做确定性依赖顺序。
- `findWorkspaceCycles`：检测依赖环。
- `listReachableWorkspacePackages`：按依赖方向获取可达 package。
- 重复 package name 和无效图输入使用结构化 `WorkspaceGraphError`。

## 快速使用

```ts
import { createWorkspaceGraph, sortWorkspacePackages } from '@openge/forge-workspace-graph';

const graph = createWorkspaceGraph([
  { dependencies: [], name: '@example/core', relativeDirectory: 'packages/core' },
  {
    dependencies: [{ kind: 'dependencies', name: '@example/core', specifier: 'workspace:^' }],
    name: '@example/app', relativeDirectory: 'apps/app',
  },
]);

const order = sortWorkspacePackages(graph, { dependencyKinds: ['dependencies'] });
```

## 行为与限制

本包不访问文件系统、不读取 `package.json`、不执行构建/发布/任务调度，也不选择包管理器。

## 与其他 Foundation Forge 包的关系

[`forge-workspace-pnpm`](workspace-pnpm.md) 是 pnpm 数据读取 Provider；[`forge-workspace-checks`](workspace-checks.md) 消费本包图结构执行可组合检查。
