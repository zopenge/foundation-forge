# HTTP(S) 传输

`@openge/forge-http-transport` 面向独立发行器、制品客户端等角色，提供领域中立的显式 HTTP(S) 传输。业务认证、重试、自动选路、幂等与恢复归消费方。它不依赖 P2P contract。

```ts
import { classifyHttpTransportError } from '@openge/forge-http-transport';
import { createNodeHttpTransport } from '@openge/forge-http-transport/node';

const transport = createNodeHttpTransport({
  route: 'proxy', environment: proxyEnvironmentSnapshot,
  noProxy: 'localhost,127.0.0.1,[::1]',
});
try {
  const route = transport.describeRoute(targetUrl);
  const response = await transport.fetch(targetUrl, { signal: abortController.signal });
  await response.body?.cancel();
  void route;
} catch (error) {
  const decision = classifyHttpTransportError(error);
  void decision;
} finally { await transport.close(); }
```

根入口仅有中立类型、`HttpTransportError`、`classifyHttpTransportError`；Node 22.14+ 使用 `/node`。公共签名不泄漏 Undici 类型。成熟 Agent/ProxyAgent 负责连接池、TLS 和 CONNECT。

## 路由与信任

route 必须为 direct 或 proxy。直连忽略代理输入；代理模式先检查 NO_PROXY，命中才直连，否则必须存在目标协议代理。无自动探测、跨协议补用或失败后回退。

proxyUrl 只支持 HTTP/HTTPS，可带百分号编码 Basic 凭据，不接受路径、query、fragment，并覆盖两协议环境值。environment 是调用方只读快照，仅在初始化读取六个大小写标准字段，不读 process.env。小写优先，空字符串也覆盖大写。HTTP 目标使用 HTTP_PROXY，HTTPS 使用 HTTPS_PROXY。显式 noProxy 覆盖环境，包括空字符串。

NO_PROXY 支持逗号/空白分隔的主机、域名、IPv4、带方括号 IPv6、可选端口、前导点或星号点域名，以及独立星号。裸域名包括子域，按完整标签匹配且忽略大小写；端口匹配目标有效端口，默认 80/443。CIDR、URL 和通用 glob 明确拒绝。创建后配置固定。

describeRoute(url: string | URL) 与 fetch 共用解析器，无 I/O。结果为 `{ route, bypassed, proxyOrigin? }`，proxyOrigin 只含 scheme/host/port；只有代理实例因 NO_PROXY 走直连时 bypassed 才为 true。缺目标协议代理抛 proxy-connect，非法或非 HTTP(S) URL 抛 unknown。上层据此避免重复直连或误报代理可用。

connectTimeoutMs 是正整数 TCP/TLS 连接期限，默认 10 秒；CONNECT 响应、正文及整体期限由请求 AbortSignal 控制。tls.ca 与 tls.proxyCa 分别接受 origin/proxy 的 PEM 字符串或只读数组，只替换实例内信任根。始终验证证书和主机名，不提供关闭验证开关。

## 请求与生命周期

fetch 具有原生调用形状：Request/URL/string 与 RequestInit，返回原生流式 Response；支持 Request 参数覆盖、流式上传（duplex half）、取消、headers、status、url、clone 与正文读取。它是服务端 HTTP(S) 适配器，不实现浏览器 cookie、缓存或 CORS。任何要求 follow 的输入仍返回原重定向；origin 4xx/5xx（含 401/403/407）完整保留，CONNECT 代理 401/403/407 统一归为不可重试的 proxy-auth 认证/授权拒绝。所有请求均不自动重试、不跟随重定向、不切路线。

正文保留背压，不缓存整个响应。默认请求 identity；gzip/deflate/Brotli 响应流式解压，移除原编码与编码长度头。未知编码保留线字节；超过五层支持编码保守失败。消费方负责限制实际读取字节数。

每实例独立拥有 dispatcher/连接池。消费或取消正文后，在 finally await close。close 取消上传、等待 headers、读取中及未读正文，显式 destroy 全部自有 dispatcher 并等待销毁；重复调用安全，后续 fetch 返回 cancelled，不影响其它实例，不无限等待未读响应完成。

## 结构化错误

分类器返回 `{ category, retryable }`：dns、timeout、connection、proxy-connect 提示 true；proxy-auth、certificate、tls、cancelled、unknown 为 false。提示不代表业务写入可以重放。代理路线在响应头前的连接失败为 proxy-connect，DNS/超时保留原分类。业务 HTTP 响应不进入分类器。

HttpTransportError 只保留符号消息和分类，不保留原始 cause、URL、凭据、token、headers、body、query 或 socket 诊断。正文流错误使用相同脱敏边界。无公开日志，无全局 dispatcher/环境、系统网络、DNS/hosts、信任库或安全策略修改，不识别或控制具体代理产品。

真实测试覆盖受管私有 CA 的 HTTPS origin、HTTP/HTTPS CONNECT、代理端解析、认证/证书/连接失败、NO_PROXY、取消/超时、流式正文、双实例与 close 释放。真实 tarball 消费使用公开 Node 入口，fixture 随仓库维护，不依赖历史临时输入。
