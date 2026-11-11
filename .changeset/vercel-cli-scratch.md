---
"@openge/forge-release-vercel": patch
---

部署 CLI 的私有配置和缓存使用执行 checkout 内的 `tmp/forge-vercel-release/`，不再随保留上传输入落入持久状态目录。临时根缺失时现场创建，并在创建与回收时核对路径链和目录身份；清理 scratch 不删除持久制品或发布恢复证据。
