---
"@openge/forge-release-vercel": minor
"@openge/forge-repository-context": patch
---

将发布恢复锚点、workspace 收据与需要保留的预构建输入移至持久目录 `state/forge-vercel-release/`，与 `tmp/` 临时过程材料分离。升级前须通过原工具版本在原宿主完成或退役活动运行；不自动查找、复制或降级复用旧目录中的恢复状态，移动路径和文件身份不能保持原恢复证明。

仓库上下文发现默认忽略新的 `tmp/` 临时目录，避免将生成过程材料重新收集为源码。
