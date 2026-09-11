# `@openge/forge-workspace-pnpm`

把显式选择的 pnpm workspace 读取为 `forge-workspace-graph` 中立 contract 的 Node.js Provider。

## 什么时候使用

适合工具需要从 `pnpm-workspace.yaml` 和匹配的 `package.json` 获取 workspace 图，但不希望 Core 图算法绑定 pnpm 文件格式的场景。

## 安装

```sh
pnpm add -D @openge/forge-workspace-graph @openge/forge-workspace-pnpm
```

## 可用入口

- `@openge/forge-workspace-pnpm`：唯一入口，Node.js Provider。

## 核心能力

- `readPnpmWorkspace`：读取调用方指定 workspace，解析 directory patterns 与 package manifests，并转换为中立图。
- 重叠 pattern 自动去重。
- 匹配到但没有 `package.json` 的容器目录会忽略。
- 缺失或格式错误的必要输入返回结构化 `WorkspacePnpmError`。

## 快速使用

```ts
import { readPnpmWorkspace } from '@openge/forge-workspace-pnpm';

const graph = await readPnpmWorkspace({ cwd: process.cwd() });
```

## 行为与限制

本包不会自动探测 npm/yarn/pnpm，也没有失败后切换其它包管理器的 fallback。manifest 编辑、lockfile 修改、构建调度和发布均不属于 Provider 职责。

## 与其他 Foundation Forge 包的关系

输出 contract 来自 [`forge-workspace-graph`](workspace-graph.md)。需要在 pnpm workspace 上直接执行规则时，可使用上层 [`forge-workspace-checks-pnpm`](workspace-checks-pnpm.md)。
