import type { NodeHttpTransportOptions } from './contracts.js';
import { HttpTransportError } from './errors.js';

interface Exclusion { readonly hostname: string; readonly port?: string }
export interface ProxyConfiguration {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  excludes(url: URL): boolean;
}

function proxyUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.href;
  } catch { throw new HttpTransportError('unknown'); }
}

function exclusions(value: string): (Exclusion | '*')[] {
  return value.split(/[,\s]+/u).filter(Boolean).map(entry => {
    if (entry === '*') return '*';
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(entry);
    if (!match?.[1] || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) throw new HttpTransportError('unknown');
    const hostname = match[1].replace(/^\*?\./u, '').toLowerCase();
    if (!hostname || /[/@?#*]/u.test(hostname)) throw new HttpTransportError('unknown');
    return { hostname, ...(match[2] ? { port: String(Number(match[2])) } : {}) };
  });
}

export function createProxyConfiguration(options: NodeHttpTransportOptions): ProxyConfiguration {
  // 只复制调用方快照中的六个标准字段；从不回读 process.env。
  const environment = options.environment;
  const httpProxy = proxyUrl(options.proxyUrl ?? environment?.http_proxy ?? environment?.HTTP_PROXY);
  const httpsProxy = proxyUrl(options.proxyUrl ?? environment?.https_proxy ?? environment?.HTTPS_PROXY);
  const excluded = exclusions(options.noProxy ?? environment?.no_proxy ?? environment?.NO_PROXY ?? '');
  return {
    ...(httpProxy ? { httpProxy } : {}), ...(httpsProxy ? { httpsProxy } : {}),
    excludes: url => {
      const hostname = url.hostname.toLowerCase(), port = url.port || (url.protocol === 'https:' ? '443' : '80');
      return excluded.some(entry => entry === '*' || ((!entry.port || entry.port === port)
        && (hostname === entry.hostname || hostname.endsWith(`.${entry.hostname}`))));
    },
  };
}
