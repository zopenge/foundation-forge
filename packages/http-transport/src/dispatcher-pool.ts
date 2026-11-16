import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import type { buildConnector, Dispatcher } from 'undici';
import { HttpTransportError, sanitizeHttpTransportError } from './errors.js';

interface Slot { readonly proxy: string | undefined; readonly dispatcher: Dispatcher; busy: boolean; retiring?: Promise<void> }
const require = createRequire(import.meta.url);
export interface DispatcherLease {
  readonly dispatcher: Dispatcher;
  release(): void;
  retire(error: Error): Promise<void>;
}

/** 每个租约只承载一个活动请求，取消连接建立时不会销毁同实例的其它请求。 */
export class DispatcherPool {
  readonly #slots = new Set<Slot>();
  #closing: Promise<void> | undefined;
  constructor(readonly requestTls: buildConnector.BuildOptions, readonly proxyTls: buildConnector.BuildOptions) {}

  #create(proxy: string | undefined): Slot {
    // 只在请求已由Node原生Request规范化后加载公开入口，避免Undici冷导入替换宿主默认dispatcher。
    const { Agent, Pool, ProxyAgent, buildConnector } = require('undici') as typeof import('undici');
    const agent = proxy ? new ProxyAgent({ uri: proxy, requestTls: this.requestTls, proxyTls: this.proxyTls, connections: 1, pipelining: 1,
      clientFactory: origin => {
        const connect = buildConnector(this.proxyTls);
        return new Pool(origin, { connections: 1, connect: (input, callback) => {
          // SNI不接受IP；清除代理实现默认填入的IP，但保留Node默认主机身份校验。
          const { servername, ...rest } = input;
          connect({ ...rest, ...(servername && !isIP(servername.replace(/^\[|\]$/gu, '')) ? { servername } : {}) }, callback);
        } });
      } }) : new Agent({ connect: this.requestTls, connections: 1, pipelining: 1 });
    // 禁止底层把任何业务请求标为可重放；CONNECT协议仍由成熟ProxyAgent处理。
    const dispatcher = agent.compose(dispatch => (input, handler) => dispatch({ ...input, idempotent: false }, handler));
    const slot = { proxy, dispatcher, busy: true };
    this.#slots.add(slot);
    return slot;
  }

  #retire(slot: Slot, error: Error): Promise<void> {
    slot.retiring ??= slot.dispatcher.destroy(error);
    void slot.retiring.then(() => this.#slots.delete(slot), () => {});
    return slot.retiring;
  }

  acquire(proxy: string | undefined, signal: AbortSignal): DispatcherLease {
    if (this.#closing) throw new HttpTransportError('cancelled');
    const slot = [...this.#slots].find(value => value.proxy === proxy && !value.busy && !value.retiring) ?? this.#create(proxy);
    slot.busy = true;
    const retire = (error: Error) => { signal.removeEventListener('abort', abort); return this.#retire(slot, error); };
    const abort = () => { void retire(sanitizeHttpTransportError(signal.reason, signal)).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return { dispatcher: slot.dispatcher, retire, release: () => {
      signal.removeEventListener('abort', abort);
      if (!slot.retiring) slot.busy = false;
    } };
  }

  close(): Promise<void> {
    this.#closing ??= Promise.all([...this.#slots].map(slot => this.#retire(slot, new HttpTransportError('cancelled')))).then(() => undefined);
    return this.#closing;
  }
}
