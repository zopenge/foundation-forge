# 数据格式与流式协议

这一组 package 只处理确定性数据表示或增量文本协议，不拥有网络连接、文件系统、业务 schema 或重试策略。

## 怎么选

| 需求 | 使用 package |
| --- | --- |
| 严格校验 JSON，并获得稳定键顺序和确定性序列化 | [`@openge/forge-deterministic-json`](deterministic-json.md) |
| 在任意字节 chunk 上增量编码/解析 JSON Lines | [`@openge/forge-json-lines`](json-lines.md) |
| 在任意字节 chunk 上增量编码/解析 Server-Sent Events | [`@openge/forge-server-sent-events`](server-sent-events.md) |

三个 package 都是 runtime-neutral；传输、持久化和业务含义由消费者负责。
