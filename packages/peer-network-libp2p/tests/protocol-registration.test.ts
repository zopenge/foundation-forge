import type { Libp2p } from 'libp2p';
import { describe, expect, test, vi } from 'vitest';

import { createLibp2pPeerNetwork } from '../src/libp2p-peer-network.js';

const protocolId = '/openge.peer-network/registration-test/1.0.0';

const createDeferred = <Value>(): {
  readonly promise: Promise<Value>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: Value) => void;
} => {
  let reject: (error: unknown) => void = () => undefined;
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

function assertLibp2pNodeDouble(value: object): asserts value is Libp2p {
  if (
    !('handle' in value)
    || typeof value.handle !== 'function'
    || !('stop' in value)
    || typeof value.stop !== 'function'
    || !('unhandle' in value)
    || typeof value.unhandle !== 'function'
  ) {
    throw new TypeError('invalid libp2p node double');
  }
}

const createNodeDouble = (
  handle: (...args: readonly unknown[]) => Promise<void>,
): {
  readonly node: Libp2p;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly unhandle: ReturnType<typeof vi.fn>;
} => {
  const stop = vi.fn(async () => undefined);
  const unhandle = vi.fn(async () => undefined);
  const node = {
    addEventListener: () => undefined,
    getMultiaddrs: () => [],
    handle,
    peerId: { toString: () => 'local-peer' },
    removeEventListener: () => undefined,
    status: 'started',
    stop,
    unhandle,
  };
  assertLibp2pNodeDouble(node);
  return { node, stop, unhandle };
};

describe('libp2p protocol registration', () => {
  test('makes concurrent listeners await one handler installation', async () => {
    const installation = createDeferred<undefined>();
    const handle = vi.fn(() => installation.promise);
    const { node } = createNodeDouble(handle);
    const network = await createLibp2pPeerNetwork({ node });
    let firstSettled = false;
    let secondSettled = false;

    const first = network.onProtocolChannel(protocolId, () => undefined).finally(() => {
      firstSettled = true;
    });
    const second = network.onProtocolChannel(protocolId, () => undefined).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(handle).toHaveBeenCalledOnce();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    installation.resolve(undefined);
    const [unsubscribeFirst, unsubscribeSecond] = await Promise.all([first, second]);
    await unsubscribeFirst();
    await unsubscribeSecond();
    await network.close();
  });

  test('rejects every waiter when installation fails and allows retry', async () => {
    const installation = createDeferred<undefined>();
    const handle = vi.fn(() => installation.promise);
    const { node } = createNodeDouble(handle);
    const network = await createLibp2pPeerNetwork({ node });
    const failure = new Error('handler-install-failed');

    const first = network.onProtocolChannel(protocolId, () => undefined);
    const second = network.onProtocolChannel(protocolId, () => undefined);
    installation.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    handle.mockResolvedValueOnce(undefined);
    const unsubscribe = await network.onProtocolChannel(protocolId, () => undefined);
    expect(handle).toHaveBeenCalledTimes(2);
    await unsubscribe();
    await network.close();
  });

  test('unhandles only after the last idempotent unsubscribe', async () => {
    const handle = vi.fn(async () => undefined);
    const { node, unhandle } = createNodeDouble(handle);
    const network = await createLibp2pPeerNetwork({ node });
    const unsubscribeFirst = await network.onProtocolChannel(protocolId, () => undefined);
    const unsubscribeSecond = await network.onProtocolChannel(protocolId, () => undefined);

    await unsubscribeFirst();
    await unsubscribeFirst();
    expect(unhandle).not.toHaveBeenCalled();

    await unsubscribeSecond();
    await unsubscribeSecond();
    expect(unhandle).toHaveBeenCalledOnce();
    await network.close();
  });

  test('unhandles once when network close races the final unsubscribe', async () => {
    const handle = vi.fn(async () => undefined);
    const { node, stop, unhandle } = createNodeDouble(handle);
    const network = await createLibp2pPeerNetwork({ node });
    const unsubscribe = await network.onProtocolChannel(protocolId, () => undefined);

    await Promise.all([network.close(), unsubscribe()]);

    expect(unhandle).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  test('rejects protocol registration after network close', async () => {
    const handle = vi.fn(async () => undefined);
    const { node } = createNodeDouble(handle);
    const network = await createLibp2pPeerNetwork({ node });
    await network.close();

    await expect(network.onProtocolChannel(
      protocolId,
      () => undefined,
    )).rejects.toMatchObject({ code: 'network-closed' });
    expect(handle).not.toHaveBeenCalled();
  });
});
