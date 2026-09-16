---
"@openge/forge-source-snapshot": patch
---

为聚合开发工作区增加显式 `submoduleHeadPolicy: 'allow-checked-out'` 模式：默认仍严格要求 submodule HEAD 与父 gitlink 一致；显式启用后使用实际 checkout HEAD 生成快照，并在不一致时把父 gitlink 作为 `parentGitlink` 来源证据写入 manifest。

同时重构 Node repository/CLI 的大仓处理链：使用临时磁盘 spool 与有界 object 批次替代全量 decoded source / packed object 常驻内存，并消除 packing、manifest 构建中的二次复杂度热点；保留 runtime-neutral 纯内存 API 作为兼容入口。
