# @openge/forge-http-transport

Explicit, isolated HTTP(S) transport for Node.js 22.14+. The root entry contains browser-safe contracts and error classification; `/node` owns Undici-backed I/O.

```ts
import { classifyHttpTransportError } from '@openge/forge-http-transport';
import { createNodeHttpTransport } from '@openge/forge-http-transport/node';

const transport = createNodeHttpTransport({
  route: 'proxy', proxyUrl: 'http://127.0.0.1:8080', noProxy: 'localhost,127.0.0.1,[::1]',
});
try {
  const route = transport.describeRoute('https://example.com/artifact');
  const response = await transport.fetch('https://example.com/artifact', {
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  void route;
} catch (error) {
  const decision = classifyHttpTransportError(error);
  void decision;
} finally { await transport.close(); }
```

`fetch` has the native call shape (`Request | URL | string`, optional `RequestInit`, streaming native `Response`). It supports Request overrides, streaming uploads with `duplex: 'half'`, abort signals, headers, status, URL, cloning and body readers. This is a server HTTP(S) adapter, not a full browser Fetch implementation: no cookie jar, browser cache or CORS. Non-HTTP(S) URLs fail. All redirects remain responses, even if the input requests following them. Origin 4xx/5xx, including origin 407, remain responses; CONNECT proxy 407 is a transport error. No request is automatically retried, redirected or rerouted.

## Options and routes

| Option | Meaning |
| --- | --- |
| `route` | Required `direct` or `proxy`; no automatic selection/fallback. |
| `proxyUrl` | HTTP/HTTPS proxy URL, optional percent-encoded Basic credentials; overrides both protocol environment values. No path, query or fragment. |
| `environment` | Caller snapshot; only `http_proxy`, `HTTP_PROXY`, `https_proxy`, `HTTPS_PROXY`, `no_proxy`, `NO_PROXY` are read, once at construction. Never reads the host environment. |
| `noProxy` | Overrides environment exclusions, including an empty string. |
| `connectTimeoutMs` | Positive integer TCP/TLS connect timeout, default 10,000 ms. Use AbortSignal for an overall deadline including CONNECT response/body. |
| `tls.ca`, `tls.proxyCa` | Optional PEM string or readonly PEM array replacing origin/proxy trust roots in this instance. Certificate and hostname validation remain enabled. |

Lowercase fields take precedence even when empty. HTTP targets require HTTP_PROXY, HTTPS targets require HTTPS_PROXY; neither protocol falls back to the other. Missing proxy configuration fails with `proxy-connect` unless NO_PROXY explicitly excludes the target. `direct` ignores all proxy/exclusion inputs. Target DNS resolution happens at the proxy.

NO_PROXY accepts comma/whitespace-separated hostnames, domains, IPv4, bracketed IPv6, optional ports, leading `.`/`*.` domains and `*`. Domains include subdomains with complete-label, case-insensitive matching. Ports match the effective target port (80/443 by default). CIDR, URLs and general globs are unsupported and rejected. Configuration is fixed at construction.

`describeRoute(url: string | URL)` shares the fetch resolver, performs no I/O and returns `{ route, bypassed, proxyOrigin? }`. `proxyOrigin` contains only scheme/host/port. `bypassed` is true only for a proxy instance taking direct because of NO_PROXY. Missing protocol proxies and invalid URLs throw the same stable errors as fetch. This prevents a caller from reporting a NO_PROXY bypass as a working proxy.

## Streams, errors and ownership

Bodies retain streaming backpressure. Requests default to identity encoding; gzip, deflate and Brotli responses are decoded if sent by the server, removing encoded content length/encoding headers. Unknown encodings remain wire bytes. More than five supported encoding layers fail conservatively. Consumers must bound accepted response bytes.

`classifyHttpTransportError(error)` returns `{ category, retryable }`. Categories `dns`, `timeout`, `connection`, `proxy-connect` have a true hint; `proxy-auth`, `certificate`, `tls`, `cancelled`, `unknown` have false. The hint never authorizes replaying a business operation. Proxy-path connectivity failures before response headers are `proxy-connect`; DNS/timeout stay distinct. Business HTTP responses are not classified.

`HttpTransportError` contains only a stable symbolic message and `classification`, with no raw cause, URL, credentials, request headers/body/query or socket diagnostics. Fetch and stream failures are sanitized; no logs are emitted. The standalone classifier accepts bounded nested/aggregate Node and Undici errors conservatively.

Each instance owns its pools/dispatchers. Consume or cancel bodies, then `await close()` in finally. Close aborts uploads, pending requests and unread/active bodies, explicitly destroys all owned dispatchers and awaits destruction. It is idempotent; later fetch calls fail with cancelled. Other instances remain usable. No global dispatcher, environment, DNS/hosts, system proxy, trust store or TLS policy changes. No proxy product detection or control.

See the [Chinese guide](../../docs/packages/networking/http-transport.md).
