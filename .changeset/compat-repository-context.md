---
"@openge/forge-repository-context": major
---

调查 SDK 统一返回必有的 `evidenceUnits`，删除 `evidenceBudget` 请求开关。调用方直接使用 `selectEvidence` 和自己的完整输出计量器按预算选择证据；禁用正文读取或无证据时返回空数组。

删除证据规划游标失败后接纳另一展示策略游标的逻辑。调查按当前结果和预算固定使用完整规划或有界正文裁剪，续页仅接受对应策略；旧版 v4 evidence policy 游标明确返回 `CURSOR_MISMATCH`，须重新获取第一页。保留巨大单行、UTF-8、范围覆盖与完整输出字节预算约束。
