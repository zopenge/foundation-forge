---
"@openge/forge-artifact-publish": minor
"@openge/forge-artifact-publish-cos": minor
---

新增中立不可变对象发布与 COS Provider：受控文件或字节输入、精确完整性与元数据回读、共享传输预算、有界并发和取消、结构化失败收据，以及全部对象验证后的指针切换与已有版本激活。COS 仅支持从未启用版本控制的 bucket；同一指针的所有写入由消费方外部串行协调。
