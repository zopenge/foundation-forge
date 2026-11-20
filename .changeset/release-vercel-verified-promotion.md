---
"@openge/forge-release-vercel": patch
---

按 Vercel 推广接口接收 HTTP `201` 和 `202`，查询项目时显式请求推广任务状态。普通 prebuilt 推广已由同槽成功 `verify` 确认时，后续发布可消费原归档证明，保留原始回执，无需再访问旧候选。
