# `@openge/forge-json-lines`

在任意字节 chunk 上增量编码和解析 UTF-8 JSON Lines 的 runtime-neutral 工具。

## 什么时候使用

适合进程标准流、网络流或文件流已经由上层持有，但需要可靠处理 JSONL 分帧、UTF-8 边界和单行大小限制的场景。

它不定义每条记录的业务 schema，也不拥有 stream 或 transport。

## 安装

```sh
pnpm add @openge/forge-json-lines
```

## 可用入口

- `@openge/forge-json-lines`：唯一入口，runtime-neutral。

## 核心能力

- `encodeJsonLine`：把一个 JSON 值编码为带换行的 UTF-8 JSONL record。
- `parseJsonLines`：解析完整字节输入。
- `createJsonLinesDecoder`：增量接收任意 chunk，正确跨 UTF-8 code point 和行边界组装记录。
- `JsonLinesError`：报告无效 UTF-8、无效 JSON、行过大及 decoder 生命周期错误。

## 快速使用

```ts
import { createJsonLinesDecoder, encodeJsonLine } from '@openge/forge-json-lines';

const decoder = createJsonLinesDecoder({ maxLineBytes: 64 * 1024 });
const records = decoder.push(new TextEncoder().encode('{"ready":true}\n'));
const encoded = encodeJsonLine({ ready: true });
const tail = decoder.finish();
```

`finish()` 用于输入结束时处理最后一条没有换行符的记录。

## 行为与限制

Decoder 完成后继续使用会失败；超出 `maxLineBytes` 会返回结构化错误。日志语义、重试、持久化、背压与记录 schema 均由消费者负责。

## 与其他 Foundation Forge 包的关系

与 [`forge-server-sent-events`](server-sent-events.md) 同属流式文本协议原语，但两者协议独立；需要稳定 JSON 对象序列化规则时另见 [`forge-deterministic-json`](deterministic-json.md)。
