import { describe, expect, it } from 'vitest';
import { activateArtifactRelease, publishArtifactRelease } from '../src/index.js';
import { MemoryTransport, object, options, plan } from './memory-transport.js';

describe('immutable artifact publication', () => {
  it('verifies every immutable object before switching and verifying the pointer', async () => {
    const transport = new MemoryTransport();
    const input = plan();

    await expect(publishArtifactRelease(transport, input, options)).resolves.toMatchObject({
      outcome: 'succeeded',
      sourceCommit: 'a'.repeat(40),
      target: transport.target,
      pointer: { key: 'current.json', writeState: 'accepted', verificationState: 'succeeded' },
      closure: { status: 'closed', activeRequests: 0 },
    });

    expect(transport.objects.get('releases/a/one.bin')?.bytes).toEqual(new TextEncoder().encode('one'));
    expect(transport.objects.get('current.json')?.bytes).toEqual(new TextEncoder().encode('{"release":"a"}'));
    const commitIndex = transport.events.indexOf('replace:current.json');
    expect(commitIndex).toBeGreaterThan(transport.events.indexOf('read:releases/a/one.bin'));
    expect(commitIndex).toBeGreaterThan(transport.events.indexOf('read:releases/a/two.bin'));
    expect(transport.events.slice(-2)).toEqual(['read:current.json', 'close']);
    expect(transport.closed).toBe(true);
  });

  it('activates existing immutable objects without uploading them again', async () => {
    const transport = new MemoryTransport();
    const input = plan();
    for (const value of input.objects) transport.objects.set(value.key, value);
    const descriptors = input.objects.map(({ key, byteLength, sha256, contentType, cacheControl }) => ({ key, byteLength, sha256, contentType, cacheControl }));

    await expect(activateArtifactRelease(transport, { ...input, objects: descriptors }, options)).resolves.toMatchObject({
      operation: 'activate', outcome: 'succeeded', closure: { status: 'closed' },
    });

    expect(transport.events.some(event => event.startsWith('create:'))).toBe(false);
    expect(transport.objects.get('current.json')?.bytes).toEqual(new TextEncoder().encode('{"release":"a"}'));
    expect(transport.objects.get('releases/a/two.bin')?.bytes).toEqual(new TextEncoder().encode('two'));
  });

  it.each([
    ['short source commit', (input: ReturnType<typeof plan>) => { input.sourceCommit = 'main'; }],
    ['escaping prefix', (input: ReturnType<typeof plan>) => { input.immutablePrefix = '../'; }],
    ['outside object', (input: ReturnType<typeof plan>) => { input.objects[0].key = 'other/one.bin'; }],
    ['pointer inside immutable prefix', (input: ReturnType<typeof plan>) => { input.pointer.key = 'releases/a/current.json'; }],
    ['duplicate object', (input: ReturnType<typeof plan>) => { input.objects.push(input.objects[0]); }],
    ['header injection', (input: ReturnType<typeof plan>) => { input.objects[0].contentType = 'text/plain\r\nx-token: secret'; }],
    ['invalid digest', (input: ReturnType<typeof plan>) => { input.objects[0].sha256 = 'not-a-digest'; }],
  ])('rejects %s before contacting storage', async (_label, mutate) => {
    const transport = new MemoryTransport();
    const input = plan();
    mutate(input);
    await expect(publishArtifactRelease(transport, input, options)).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    expect(transport.events).toEqual(['close']);
    expect(transport.objects.size).toBe(0);
  });

  it.each([
    { concurrency: 0 }, { timeoutMilliseconds: 0 }, { closeTimeoutMilliseconds: -1 },
    { maxObjectBytes: 0 }, { maxTotalBytes: Number.MAX_VALUE }, { maxPointerBytes: 0 },
    { concurrencyControl: { mode: 'none', scope: 'unsafe' } },
  ])('requires explicit valid resource and serialization controls: %j', async change => {
    const transport = new MemoryTransport();
    const pending = Reflect.apply(publishArtifactRelease, undefined, [transport, plan(), { ...options, ...change }]);
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(transport.events).toEqual(['close']);
  });

  it.each([
    { maxObjectBytes: 2 }, { maxTotalBytes: 6 }, { maxPointerBytes: 2 },
  ])('rejects a plan exceeding a declared byte cap: %j', async change => {
    const transport = new MemoryTransport();
    await expect(publishArtifactRelease(transport, plan(), { ...options, ...change })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    expect(transport.events).toEqual(['close']);
  });

  it('rejects corrupt local bytes before any remote write', async () => {
    const transport = new MemoryTransport();
    const input = plan();
    input.objects[0].bytes[0] = 0;
    await expect(publishArtifactRelease(transport, input, options)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
    expect(transport.events).toEqual(['close']);
    expect(transport.objects.size).toBe(0);
  });

  it('keeps conflicting existing bytes and leaves the pointer untouched', async () => {
    const transport = new MemoryTransport();
    transport.objects.set('releases/a/one.bin', object('releases/a/one.bin', 'bad'));
    await expect(publishArtifactRelease(transport, plan(), options)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
      receipt: {
        outcome: 'failed',
        failure: { code: 'INTEGRITY_MISMATCH', phase: 'objects', key: 'releases/a/one.bin' },
        pointer: { writeState: 'not-attempted' },
        closure: { status: 'closed' },
      },
    });
    expect(transport.objects.get('releases/a/one.bin')?.bytes).toEqual(new TextEncoder().encode('bad'));
    expect(transport.objects.has('current.json')).toBe(false);
    expect(transport.closed).toBe(true);
  });

  it('does not overwrite metadata for an existing immutable object', async () => {
    const transport = new MemoryTransport();
    transport.objects.set('releases/a/one.bin', { ...object('releases/a/one.bin', 'one'), contentType: 'text/plain' });
    await expect(publishArtifactRelease(transport, plan(), options)).rejects.toMatchObject({ code: 'METADATA_MISMATCH' });
    expect(transport.objects.get('releases/a/one.bin')?.contentType).toBe('text/plain');
    expect(transport.objects.has('current.json')).toBe(false);
  });

  it('freezes caller byte and descriptor inputs before asynchronous storage work', async () => {
    const transport = new MemoryTransport();
    const input = plan();
    let releasePrepare!: () => void;
    let enteredPrepare!: () => void;
    const entered = new Promise<void>(resolve => { enteredPrepare = resolve; });
    const gate = new Promise<void>(resolve => { releasePrepare = resolve; });
    transport.prepare = async () => { enteredPrepare(); await gate; };
    const pending = publishArtifactRelease(transport, input, options);
    await entered;
    input.objects[0].bytes.fill(0);
    input.objects[0].key = 'other/changed.bin';
    input.objects.length = 1;
    input.pointer.bytes.fill(0);
    releasePrepare();
    await expect(pending).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(transport.objects.get('releases/a/one.bin')?.bytes).toEqual(new TextEncoder().encode('one'));
    expect(transport.objects.get('releases/a/two.bin')?.bytes).toEqual(new TextEncoder().encode('two'));
    expect(transport.objects.get('current.json')?.bytes).toEqual(new TextEncoder().encode('{"release":"a"}'));
  });

  it('redacts unknown transport errors while preserving safe phase and write facts', async () => {
    const transport = new MemoryTransport();
    transport.readObject = async () => { throw new Error('FIXTURE_SECRET_TOKEN'); };
    const failure: unknown = await publishArtifactRelease(transport, plan(), options).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'TRANSPORT_FAILED', receipt: { outcome: 'failed', pointer: { writeState: 'not-attempted' } } });
    expect(`${String(failure)}${JSON.stringify(failure)}`).not.toContain('FIXTURE_SECRET_TOKEN');
    expect(failure).not.toHaveProperty('cause');
    expect(transport.closed).toBe(true);
  });

  it('does not call a publication successful when transport closure is unconfirmed', async () => {
    const transport = new MemoryTransport();
    const uncertainTransport = { ...transport, target: transport.target,
      prepare: transport.prepare.bind(transport), createObject: transport.createObject.bind(transport),
      readObject: transport.readObject.bind(transport), replaceObject: transport.replaceObject.bind(transport),
      close: async () => ({ status: 'unconfirmed' as const, activeRequests: 1 }),
    };
    await expect(publishArtifactRelease(uncertainTransport, plan(), options)).rejects.toMatchObject({
      code: 'CLOSURE_UNCONFIRMED', receipt: { outcome: 'failed', pointer: { verificationState: 'succeeded' }, closure: { status: 'unconfirmed', activeRequests: 1 } },
    });
  });
});
