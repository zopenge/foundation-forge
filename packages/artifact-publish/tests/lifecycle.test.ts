import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactPublicationError, publishArtifactRelease,
  type ArtifactPublicationTransport, type ArtifactTransportClosure,
} from '../src/index.js';
import { deferred, MemoryTransport, object, options, plan } from './memory-transport.js';

afterEach(() => { vi.useRealTimers(); });

describe('publication lifetime', () => {
  it('uses the declared parallelism without exceeding it', async () => {
    const storage = new MemoryTransport();
    const gate = deferred<undefined>();
    const input = plan();
    input.objects.push(object('releases/a/three.bin', 'three'));
    const create = storage.createObject.bind(storage);
    let active = 0;
    let peak = 0;
    storage.createObject = async value => {
      active += 1;
      peak = Math.max(peak, active);
      try { await gate.promise; return await create(value); }
      finally { active -= 1; }
    };
    const pending = publishArtifactRelease(storage, input, options);
    try {
      await vi.waitFor(() => { expect(active).toBe(2); }, { timeout: 500, interval: 10 });
    } finally {
      gate.resolve(undefined);
      await pending;
    }
    expect(peak).toBe(2);
    expect(storage.objects.size).toBe(4);
  });

  it('rejects a signal cancelled before entry without touching storage', async () => {
    const storage = new MemoryTransport();
    const controller = new AbortController();
    controller.abort('private reason');
    await expect(publishArtifactRelease(storage, plan(), { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(storage.events).toEqual(['close']);
  });

  it('does not switch a pointer after cancellation at the last object verification', async () => {
    const storage = new MemoryTransport();
    const controller = new AbortController();
    const read = storage.readObject.bind(storage);
    storage.readObject = async request => {
      const result = await read(request);
      if (request.key === 'releases/a/two.bin') controller.abort();
      return result;
    };
    await expect(publishArtifactRelease(storage, plan(), { ...options, signal: controller.signal })).rejects.toMatchObject({
      code: 'OPERATION_ABORTED', receipt: { pointer: { writeState: 'not-attempted' }, closure: { status: 'closed' } },
    });
    expect(storage.objects.has('current.json')).toBe(false);
  });

  it('preserves unknown pointer write outcome when cancelled after bytes were sent', async () => {
    const storage = new MemoryTransport();
    const controller = new AbortController();
    const replace = storage.replaceObject.bind(storage);
    storage.replaceObject = async value => { await replace(value); controller.abort(); };
    await expect(publishArtifactRelease(storage, plan(), { ...options, signal: controller.signal })).rejects.toMatchObject({
      code: 'OPERATION_ABORTED', receipt: { pointer: { writeState: 'unknown', verificationState: 'failed' } },
    });
    expect(storage.objects.get('current.json')?.bytes).toEqual(new TextEncoder().encode('{"release":"a"}'));
  });

  it('ends a stalled request on the shared budget without reporting a false close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const storage = new MemoryTransport();
    const entered = deferred<undefined>();
    const gate = deferred<undefined>();
    const transport: ArtifactPublicationTransport = storage;
    let requestAborted = false;
    transport.prepare = async context => {
      context.signal.addEventListener('abort', () => { requestAborted = true; }, { once: true });
      entered.resolve(undefined);
      await gate.promise;
    };
    let settled = false;
    const outcome = publishArtifactRelease(storage, plan(), { ...options, timeoutMilliseconds: 50 })
      .then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(51);
      expect(requestAborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({ error: { code: 'BUDGET_EXCEEDED', receipt: { closure: { status: 'unconfirmed' }, pointer: { writeState: 'not-attempted' } } } });
    } finally {
      gate.resolve(undefined);
      await outcome;
    }
  });

  it('waits for cancelled owned requests to settle within the close budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const storage = new MemoryTransport();
    const transport: ArtifactPublicationTransport = storage;
    const entered = deferred<undefined>();
    transport.prepare = async context => {
      entered.resolve(undefined);
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          setTimeout(() => { reject(new ArtifactPublicationError('OPERATION_ABORTED')); }, 5);
        }, { once: true });
      });
    };
    const outcome = publishArtifactRelease(storage, plan(), { ...options, timeoutMilliseconds: 50 })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(151);
    await expect(outcome).resolves.toMatchObject({ error: { code: 'BUDGET_EXCEEDED', receipt: { closure: { status: 'closed', activeRequests: 0 } } } });
  });

  it('bounds closure waiting and preserves a successfully verified pointer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const storage = new MemoryTransport();
    const entered = deferred<undefined>();
    const gate = deferred<ArtifactTransportClosure>();
    storage.close = async () => { entered.resolve(undefined); return gate.promise; };
    let settled = false;
    const outcome = publishArtifactRelease(storage, plan(), options)
      .then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(101);
      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({ error: { code: 'CLOSURE_UNCONFIRMED', receipt: { pointer: { verificationState: 'succeeded' }, closure: { status: 'unconfirmed' } } } });
    } finally {
      gate.resolve({ status: 'closed', activeRequests: 0 });
      await outcome;
    }
  });

  it('stops new dispatch and cancels siblings after the first object fails', async () => {
    const storage = new MemoryTransport();
    const firstFailure = deferred<undefined>();
    const started: string[] = [];
    const controller = new AbortController();
    const input = plan();
    input.objects.push(object('releases/a/three.bin', 'three'));
    const transport: ArtifactPublicationTransport = {
      target: storage.target,
      prepare: storage.prepare.bind(storage),
      readObject: storage.readObject.bind(storage),
      replaceObject: storage.replaceObject.bind(storage),
      close: storage.close.bind(storage),
      createObject: async (value, context) => {
        started.push(value.key);
        if (value.key.endsWith('one.bin')) {
          await firstFailure.promise;
          throw new ArtifactPublicationError('OBJECT_CONFLICT');
        }
        await new Promise<void>((resolve, reject) => {
          if (context.signal.aborted) { reject(new ArtifactPublicationError('OPERATION_ABORTED')); return; }
          context.signal.addEventListener('abort', () => { resolve(); }, { once: true });
        });
        throw new ArtifactPublicationError('OPERATION_ABORTED');
      },
    };
    const outcome = publishArtifactRelease(transport, input, { ...options, signal: controller.signal })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => { expect(started).toHaveLength(2); }, { timeout: 500, interval: 10 });
      firstFailure.resolve(undefined);
      await expect(outcome).resolves.toMatchObject({ error: { code: 'OBJECT_CONFLICT', receipt: { pointer: { writeState: 'not-attempted' } } } });
      expect(started).toEqual(['releases/a/one.bin', 'releases/a/two.bin']);
      expect(storage.closed).toBe(true);
    } finally {
      firstFailure.resolve(undefined);
      controller.abort();
      await outcome;
    }
  });

  it('rejects concurrent and later reuse without closing another operation resources', async () => {
    const storage = new MemoryTransport();
    const entered = deferred<undefined>();
    const gate = deferred<undefined>();
    storage.prepare = async () => { entered.resolve(undefined); await gate.promise; };
    const pending = publishArtifactRelease(storage, plan(), options);
    let second: Promise<unknown> | undefined;
    try {
      await entered.promise;
      let settled = false;
      second = publishArtifactRelease(storage, plan(), options)
        .then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
      await vi.waitFor(() => { expect(settled).toBe(true); }, { timeout: 500, interval: 10 });
      await expect(second).resolves.toMatchObject({ error: { code: 'TRANSPORT_IN_USE' } });
      expect(storage.closed).toBe(false);
    } finally {
      gate.resolve(undefined);
      await Promise.all([pending, second]);
    }
    await expect(publishArtifactRelease(storage, plan(), options)).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
    expect(storage.events.filter(event => event === 'close')).toHaveLength(1);
  });
});
