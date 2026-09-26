---
"@openge/forge-repository-context": minor
---

Add compact paginated CLI responses, batch source reads, semantic-input freshness verification, deterministic lexical/BM25 evidence retrieval, and verified Source Snapshot frozen reads.

Add verified semantic evidence upgrades and exact byte-budget selection for CLI investigation responses, with explicit delivered ranges, expansion targets, and separate entry-pagination and body-truncation flags.

Bind evidence continuation to a stable display sequence, preserve explicit path scopes, and recognize decoded Windows query paths without broadening the requested search boundary.

Apply the effective request scope before body reads, preserve explicitly named symbols during hybrid retrieval, and reject evidence selections whose fixed response cost exceeds the public byte budget.

Balance candidates across explicitly named directories in multi-component queries so one component cannot consume every candidate slot.

Repository-context generation indexes now use schema v2; schema v1 local caches must be rebuilt instead of being treated as current.

当调查证据或批量读取的完整响应已满足总字节预算时，保留全部正文，避免平均分配文本额度造成不必要的裁剪。

修正恢复片段的 SourceRef 行范围，使调查首查与续页的完整范围声明对应真实源码切片，避免将十行片段误标为整文件。
