# 仓库工具

这一组 package 面向代码仓库工具链：先发现文件，再做纯上下文规划或文本质量检查。

## 怎么选

| 需求 | 使用 package |
| --- | --- |
| 只读获取 Git 仓库文件、变更文件或 ignore 过滤结果 | [`@openge/forge-repository-files`](repository-files.md) |
| 对候选执行 profile/recipe 校验、上下文选择、影响闭包和预算诊断 | [`@openge/forge-repository-context`](repository-context.md) |
| 检查文本损坏，并可扫描路径或 Git 变更集 | [`@openge/forge-text-integrity`](text-integrity.md) |

`repository-files` 负责 Git 文件发现；`repository-context` 不读取文件；`text-integrity` 的 Node 入口可组合 `repository-files`。三者不拥有具体产品的仓库语义。
