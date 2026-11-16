export type HttpTransportErrorCategory =
  | 'dns' | 'timeout' | 'connection' | 'proxy-connect' | 'proxy-auth'
  | 'certificate' | 'tls' | 'cancelled' | 'unknown';

export interface HttpTransportErrorClassification {
  readonly category: HttpTransportErrorCategory;
  readonly retryable: boolean;
}

export interface NodeHttpTransportOptions {
  readonly route: 'direct' | 'proxy';
  readonly proxyUrl?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly noProxy?: string;
  readonly connectTimeoutMs?: number;
  readonly tls?: { readonly ca?: string | readonly string[]; readonly proxyCa?: string | readonly string[] };
}

export interface HttpTransport {
  readonly fetch: typeof globalThis.fetch;
  describeRoute(url: string | URL): HttpTransportRoute;
  close(): Promise<void>;
}

export interface HttpTransportRoute {
  readonly route: 'direct' | 'proxy';
  readonly proxyOrigin?: string;
  readonly bypassed: boolean;
}
