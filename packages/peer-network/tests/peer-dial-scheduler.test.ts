import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  PeerAdvertisement,
  PeerConnection,
  PeerDialSchedulerEvent,
  PeerNetwork,
} from '../src/index.js';

const remoteAdvertisement: PeerAdvertisement = {
  endpoint: {
    addresses: ['/ip4/127.0.0.1/tcp/4002'],
    peerId: 'remote-peer',
  },
  scopeId: 'scope-a',
};

const createNetworkDouble = (
  connect: PeerNetwork['connect'],
  onEvent: PeerNetwork['onEvent'] = () => () => undefined,
): PeerNetwork => ({
  close: async () => undefined,
  connect,
  endpoint: {
    addresses: ['/ip4/127.0.0.1/tcp/4001'],
    peerId: 'local-peer',
  },
  localPeerId: 'local-peer',
  onConnection: () => () => undefined,
  onEvent,
  onProtocolChannel: async () => async () => undefined,
});

const createConnectionDouble = (
  close: PeerConnection['close'] = async () => undefined,
): PeerConnection => ({
  close,
  openChannel: async () => {
    throw new Error('not implemented');
  },
  remotePeerId: 'remote-peer',
});

describe('peer dial scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('retries failed peer connections and reports the first success', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    const connection = createConnectionDouble();
    let attempts = 0;
    const connected: string[] = [];
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('unreachable');
        }
        return connection;
      }),
      onConnected: (peerConnection) => {
        connected.push(peerConnection.remotePeerId);
      },
      retryDelaysMs: [0, 100],
    });

    scheduler.consider([remoteAdvertisement]);
    await vi.advanceTimersByTimeAsync(100);

    expect(attempts).toBe(2);
    expect(connected).toEqual(['remote-peer']);
    scheduler.close();
  });

  test('skips the local peer and aborts scheduled work when closed', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    let attempts = 0;
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => {
        attempts += 1;
        throw new Error('unreachable');
      }),
      retryDelaysMs: [100],
    });

    scheduler.consider([
      {
        endpoint: {
          addresses: ['/ip4/127.0.0.1/tcp/4001'],
          peerId: 'local-peer',
        },
        scopeId: 'scope-a',
      },
      remoteAdvertisement,
    ]);
    scheduler.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(attempts).toBe(0);
  });

  test('keeps retries serial when a dial crosses later deadlines', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    let rejectFirst: (error: Error) => void = () => undefined;
    let attempts = 0;
    let activeAttempts = 0;
    let maxActiveAttempts = 0;
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => {
        attempts += 1;
        activeAttempts += 1;
        maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts);
        try {
          if (attempts === 1) {
            await new Promise<never>((_, reject) => {
              rejectFirst = reject;
            });
          }
          return createConnectionDouble();
        } finally {
          activeAttempts -= 1;
        }
      }),
      retryDelaysMs: [0, 100],
    });

    scheduler.consider([remoteAdvertisement]);
    await vi.advanceTimersByTimeAsync(100);

    expect(attempts).toBe(1);
    expect(maxActiveAttempts).toBe(1);

    rejectFirst(new Error('unreachable'));
    await vi.runAllTimersAsync();

    expect(attempts).toBe(2);
    expect(maxActiveAttempts).toBe(1);
    scheduler.close();
  });

  test('does not reschedule a peer while its dial is in flight', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    let resolveDial: (connection: PeerConnection) => void = () => undefined;
    let attempts = 0;
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => {
        attempts += 1;
        return new Promise<PeerConnection>((resolve) => {
          resolveDial = resolve;
        });
      }),
      retryDelaysMs: [0],
    });

    scheduler.consider([remoteAdvertisement]);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.consider([remoteAdvertisement]);
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts).toBe(1);
    resolveDial(createConnectionDouble());
    await vi.runAllTimersAsync();
    scheduler.close();
  });

  test('closes a connection and retries when setup fails', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    const close = vi.fn<PeerConnection['close']>(async () => undefined);
    const events: PeerDialSchedulerEvent[] = [];
    let attempts = 0;
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => {
        attempts += 1;
        return createConnectionDouble(attempts === 1 ? close : undefined);
      }),
      onConnected: async () => {
        if (attempts === 1) {
          throw new Error('snapshot failed');
        }
      },
      retryDelaysMs: [0, 100],
    });
    scheduler.onEvent((event) => events.push(event));

    scheduler.consider([remoteAdvertisement]);
    await vi.runAllTimersAsync();

    expect(attempts).toBe(2);
    expect(close).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(['setup-failed', 'connected']);
    expect(events[0]).toMatchObject({
      endpoint: remoteAdvertisement.endpoint,
      error: expect.objectContaining({ message: 'snapshot failed' }),
      type: 'setup-failed',
    });
    scheduler.close();
  });

  test('reports connection cleanup failure after setup rejection', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    const cleanupError = new Error('connection cleanup failed');
    const events: PeerDialSchedulerEvent[] = [];
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => createConnectionDouble(async () => {
        throw cleanupError;
      })),
      onConnected: async () => {
        throw new Error('snapshot failed');
      },
      retryDelaysMs: [0],
    });
    scheduler.onEvent((event) => events.push(event));

    scheduler.consider([remoteAdvertisement]);
    await vi.runAllTimersAsync();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cleanupError,
      type: 'setup-failed',
    });
    scheduler.close();
  });

  test('allows a later advertisement after retry exhaustion', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    let attempts = 0;
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => {
        attempts += 1;
        throw new Error('unreachable');
      }),
      retryDelaysMs: [0],
    });

    scheduler.consider([remoteAdvertisement]);
    await vi.runAllTimersAsync();
    scheduler.consider([remoteAdvertisement]);
    await vi.runAllTimersAsync();

    expect(attempts).toBe(2);
    scheduler.close();
  });

  test('allows rediscovery after the network reports a remote disconnect', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    let emitNetworkEvent: Parameters<PeerNetwork['onEvent']>[0] = () => undefined;
    let attempts = 0;
    const removeNetworkListener = vi.fn(() => undefined);
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(
        async () => {
          attempts += 1;
          return createConnectionDouble();
        },
        (listener) => {
          emitNetworkEvent = listener;
          return removeNetworkListener;
        },
      ),
      retryDelaysMs: [0],
    });

    scheduler.consider([remoteAdvertisement]);
    await vi.runAllTimersAsync();
    emitNetworkEvent({ peerId: 'remote-peer', type: 'peer-disconnected' });
    scheduler.consider([remoteAdvertisement]);
    await vi.runAllTimersAsync();

    expect(attempts).toBe(2);
    scheduler.close();
    expect(removeNetworkListener).toHaveBeenCalledOnce();
  });

  test('invalidates setup work when the peer disconnects before setup completes', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    let emitNetworkEvent: Parameters<PeerNetwork['onEvent']>[0] = () => undefined;
    let resolveSetup: () => void = () => undefined;
    const setup = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });
    const firstClose = vi.fn<PeerConnection['close']>(async () => undefined);
    let attempts = 0;
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(
        async () => {
          attempts += 1;
          return createConnectionDouble(attempts === 1 ? firstClose : undefined);
        },
        (listener) => {
          emitNetworkEvent = listener;
          return () => undefined;
        },
      ),
      onConnected: async () => setup,
      retryDelaysMs: [0],
    });

    scheduler.consider([remoteAdvertisement]);
    await vi.advanceTimersByTimeAsync(0);
    emitNetworkEvent({ peerId: 'remote-peer', type: 'peer-disconnected' });
    resolveSetup();
    await vi.runAllTimersAsync();
    scheduler.consider([remoteAdvertisement]);
    await vi.runAllTimersAsync();

    expect(firstClose).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
    scheduler.close();
  });

  test('closes a late connection without publishing after scheduler close', async () => {
    const { createPeerDialScheduler } = await import('../src/index.js');
    let resolveDial: (connection: PeerConnection) => void = () => undefined;
    const close = vi.fn<PeerConnection['close']>(async () => undefined);
    const events: PeerDialSchedulerEvent[] = [];
    const scheduler = createPeerDialScheduler({
      network: createNetworkDouble(async () => new Promise<PeerConnection>((resolve) => {
        resolveDial = resolve;
      })),
      retryDelaysMs: [0, 100],
    });
    scheduler.onEvent((event) => events.push(event));

    scheduler.consider([remoteAdvertisement]);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.close();
    resolveDial(createConnectionDouble(close));
    await vi.runAllTimersAsync();

    expect(close).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
