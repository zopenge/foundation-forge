# `@openge/forge-workspace-checks-pnpm`

把 pnpm workspace Provider 与 Workspace Checks Core 组合成可直接调用的集成 facade 和 CLI。

## 什么时候使用

适合 CI 或仓库脚本希望“一条命令检查 pnpm workspace”，而不想自行组装 workspace 读取和 Core 检查的场景。

## 安装

```sh
pnpm add -D @openge/forge-workspace-checks-pnpm
```

## 可用入口

- `@openge/forge-workspace-checks-pnpm`：programmatic facade。
- `forge-workspace-checks`：CLI。

## 核心能力

- `checkPnpmWorkspace`：读取 pnpm workspace 后执行指定 checks；未提供 checks 时使用内置 `package-cycles`。
- CLI 参数解析、稳定诊断格式和退出码映射。
- CLI `--cwd` 与 `--check package-cycles`。

## 快速使用

```sh
forge-workspace-checks --cwd . --check package-cycles
```

Programmatic：

```ts
import { checkPnpmWorkspace } from '@openge/forge-workspace-checks-pnpm';

const report = await checkPnpmWorkspace({ cwd: process.cwd() });
```

CLI 检查通过返回 0，有 findings 返回 1，参数或 workspace 读取错误返回 2。

## 行为与限制

本包是集成 facade，不是新的 pnpm Provider。它只读取请求的 workspace，不修改 package manifest、workspace 配置或 lockfile。

## 与其他 Foundation Forge 包的关系

检查规则来自 [`forge-workspace-checks`](workspace-checks.md)，pnpm 数据读取来自 [`forge-workspace-pnpm`](workspace-pnpm.md)，图 contract 来自 [`forge-workspace-graph`](workspace-graph.md)。
