# 制品与文件安全

这一组 package 从底层路径和完整性原语，逐步组合到 ZIP、生成物发布和配置包导入。

## 怎么选

| 需求 | 使用 package |
| --- | --- |
| 校验便携相对路径或 Node 根目录包含关系 | [`@openge/forge-path-safety`](path-safety.md) |
| 计算或验证 SHA-256 与字节长度 | [`@openge/forge-artifact-integrity`](artifact-integrity.md) |
| 校验归档 entry 路径、类型、数量和展开大小 | [`@openge/forge-archive-safety`](archive-safety.md) |
| 内存中的确定性 ZIP32 编解码与安全检查 | [`@openge/forge-archive-zip`](archive-zip.md) |
| 声明生成物计划、比较快照并安全发布文件 | [`@openge/forge-generated-artifacts`](generated-artifacts.md) |
| 创建带 manifest 的确定性配置 ZIP，并在 Node 中预检或导入 | [`@openge/forge-config-bundle`](config-bundle.md) |

## 组合关系

底层原语只负责单一安全或确定性问题；上层 package 显式组合它们。`config-bundle` 是该域中组合度最高的能力，但仍不负责产品文件选择、Secret 规则或业务配置语义。
