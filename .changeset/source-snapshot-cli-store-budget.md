---
"@openge/forge-source-snapshot": patch
---

修复 source-snapshot CLI 配置未转发 managed-store 发布预算的问题；consumer 现在可以通过 `storeBudget.maxManagedFiles` 与 `storeBudget.maxManagedBytes` 保留与 Node API 一致的发布前物理存储门禁。
