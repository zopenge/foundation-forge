# Workspace 工具

这一组 package 把“中立 workspace 图”“pnpm 读取 Provider”“纯检查规则”和“pnpm CLI 集成”拆成独立层。

## 怎么选

| 需求 | 使用 package |
| --- | --- |
| 已有包元数据，只需要构图、环检测、可达性和拓扑排序 | [`@openge/forge-workspace-graph`](workspace-graph.md) |
| 从 `pnpm-workspace.yaml` 和 package manifests 读取中立图 | [`@openge/forge-workspace-pnpm`](workspace-pnpm.md) |
| 对中立图执行可组合检查 | [`@openge/forge-workspace-checks`](workspace-checks.md) |
| 直接对 pnpm workspace 执行检查或使用 CLI | [`@openge/forge-workspace-checks-pnpm`](workspace-checks-pnpm.md) |

依赖方向保持为 Provider/集成层指向 Core；没有包管理器自动探测，也不修改 manifest 或 lockfile。
