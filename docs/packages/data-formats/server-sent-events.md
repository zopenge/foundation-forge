# `@openge/forge-server-sent-events`

增量编码和解析 Server-Sent Events（SSE）字段与事件边界的 runtime-neutral 工具。

## 什么时候使用

适合 HTTP 连接或其它字节来源已经由上层持有，但需要独立、可测试地处理 SSE framing 的场景。

它不创建 HTTP 请求，也不负责 EventSource 重连策略、鉴权或业务事件模型。

## 安装

```sh
pnpm add @openge/forge-server-sent-events
```

## 可用入口

- `@openge/forge-server-sent-events`：唯一入口，runtime-neutral。

## 核心能力

- `encodeServerSentEvent`：把事件字段编码为 UTF-8 SSE bytes。
- `createServerSentEventDecoder`：增量解析任意 chunk。
- 支持 CR、LF 和 CRLF 事件边界，合并重复 `data` 字段，并忽略 comment 行。
- `ServerSentEventError`：报告无效输入和事件大小上限错误。

## 快速使用

```ts
import {
  createServerSentEventDecoder,
  encodeServerSentEvent,
} from '@openge/forge-server-sent-events';

const decoder = createServerSentEventDecoder({ maxEventBytes: 64 * 1024 });
const events = decoder.push(new TextEncoder().encode('event: ready\ndata: ok\n\n'));
const encoded = encodeServerSentEvent({ data: 'ok', event: 'ready' });
```

## 行为与限制

本包只拥有 SSE 文本协议本身。连接生命周期、认证、重连、heartbeat 策略、业务事件类型、UI 展示和持久化由消费者负责。

## 与其他 Foundation Forge 包的关系

与 [`forge-json-lines`](json-lines.md) 一样处理增量 UTF-8 chunk，但协议和错误契约各自独立，不应互相替代。
