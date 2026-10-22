import { expect, test, vi } from 'vitest';
import { createLinuxSubreaper } from '../src/owned-scope/linux-subreaper.js';
import type { SupervisorPort } from '../src/owned-scope/supervisor.js';

test('a rejected provisional pidfd is closed without receiving termination authority', async () => {
  const signal = vi.fn(() => ({ ok: true, errno: 0 })), close = vi.fn();
  let reads = 0;
  const port: SupervisorPort = { boot: Promise.resolve(), startupSignal: new AbortController().signal, terminationTimeoutMs: 100, assertRootInstance: () => {}, rpc: async () => { throw Error('fixture channel lost'); } };
  const backend = await createLinuxSubreaper(port, {
    load: async () => ({ establish() {}, reap: () => ({ pid: -1, errno: 10 }), open: () => ({ fd: 17, errno: 0 }), signal, close }),
    ticks: async () => String(++reads), readIdentity: async () => ({ status: 'FOUND', identity: { pid: 123, startToken: 'reused-pid' } }),
  });
  await expect(backend.attach(123)).rejects.toThrow();
  await expect(backend.force()).rejects.toThrow(); await backend.dispose();
  expect(signal.mock.calls).toEqual([]); expect(close).toHaveBeenCalledExactlyOnceWith(17);
});
