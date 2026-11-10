import { describe, expect, it } from 'vitest';
import {
  bindArtifactOperation, observeArtifactOperation, performArtifactOperation,
} from '../src/index.js';
import type {
  ArtifactOperationBinding, ArtifactOperationJournal, ArtifactOperationRecord,
  ArtifactOperationTransport,
} from '../src/index.js';

const target = { provider: 'fixture', namespace: 'releases', endpoint: 'https://publish.invalid' };
const options = { timeoutMilliseconds: 1_000, closeTimeoutMilliseconds: 100 };
const input = { requestId: 'release-1', sourceCommit: 'a'.repeat(40), target,
  capability: 'deployment-create' as const, configurationSha256: 'b'.repeat(64),
  inputs: [{ name: 'static', sha256: 'c'.repeat(64), byteLength: 4 }] };

function journal() {
  let saved: ArtifactOperationRecord | undefined;
  const port: ArtifactOperationJournal = {
    async load() { return saved && structuredClone(saved); },
    async compareAndSet({ expectedRevision, next }) {
      if ((saved?.revision ?? 0) !== expectedRevision) return 'conflict';
      saved = structuredClone(next);
      return 'stored';
    },
  };
  return { port, read: () => saved };
}

function transport(binding: ArtifactOperationBinding, overrides: Partial<ArtifactOperationTransport> = {}) {
  const calls: string[] = [];
  const port: ArtifactOperationTransport = {
    target, capability: binding.capability, configurationSha256: binding.configurationSha256,
    async execute() { calls.push('execute'); return { state: 'accepted', reference: 'dep-1' }; },
    async observe() { calls.push('observe'); return { state: 'succeeded', fingerprint: binding.fingerprint, reference: 'dep-1' }; },
    async close() { calls.push('close'); return { status: 'closed', activeRequests: 0 }; },
    ...overrides,
  };
  return { port, calls };
}

describe('durable artifact operations', () => {
  it('claims before mutation, separates acceptance from observation and refuses repeat execution', async () => {
    const binding = await bindArtifactOperation(input);
    const store = journal();
    const backend = transport(binding, { async execute() {
      expect(store.read()?.writeState).toBe('unknown');
      expect(store.read()?.revision).toBe(1);
      return { state: 'accepted', reference: 'dep-1' };
    } });
    const result = await performArtifactOperation(backend.port, binding, store.port, options);
    expect(result.outcome).toBe('succeeded');
    expect(result.record).toMatchObject({ revision: 3, writeState: 'accepted', observation: 'succeeded', reference: 'dep-1' });
    expect(result.closure).toEqual({ status: 'closed', activeRequests: 0 });
    const repeat = transport(binding);
    await expect(performArtifactOperation(repeat.port, binding, store.port, options)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(repeat.calls).toEqual(['close']);
  });

  it('keeps a lost response unknown and recovers by observing without a second mutation', async () => {
    const binding = await bindArtifactOperation(input), store = journal();
    const first = transport(binding, { async execute() { throw Error('secret-token'); } });
    const error = await performArtifactOperation(first.port, binding, store.port, options).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'PROVIDER_FAILED', receipt: { record: { writeState: 'unknown', attemptFailure: 'PROVIDER_FAILED' } } });
    expect(JSON.stringify(error)).not.toContain('secret-token');
    const recovery = transport(binding);
    const observed = await observeArtifactOperation(recovery.port, binding, store.port, options);
    expect(observed.outcome).toBe('succeeded');
    expect(observed.record).toMatchObject({ writeState: 'unknown', observation: 'succeeded', attemptFailure: 'PROVIDER_FAILED' });
    expect(recovery.calls).toEqual(['observe', 'close']);
  });

  it('does not treat accepted or absent observations as ready or safe to replay', async () => {
    const binding = await bindArtifactOperation(input), store = journal();
    const pending = transport(binding, { async observe() { return { state: 'pending', fingerprint: binding.fingerprint, reference: 'dep-1' }; } });
    expect((await performArtifactOperation(pending.port, binding, store.port, options)).outcome).toBe('pending');
    const absent = transport(binding, { async observe() { return { state: 'absent', fingerprint: binding.fingerprint }; } });
    expect((await observeArtifactOperation(absent.port, binding, store.port, options)).outcome).toBe('unknown');
    await expect(performArtifactOperation(transport(binding).port, binding, store.port, options)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  it('rejects changed source, inputs, target or command configuration before mutation', async () => {
    const binding = await bindArtifactOperation(input), store = journal();
    await performArtifactOperation(transport(binding).port, binding, store.port, options);
    for (const changed of [{ sourceCommit: 'd'.repeat(40) }, { configurationSha256: 'd'.repeat(64) },
      { inputs: [{ name: 'static', sha256: 'd'.repeat(64), byteLength: 4 }] }]) {
      const different = await bindArtifactOperation({ ...input, ...changed });
      const backend = transport(different);
      await expect(observeArtifactOperation(backend.port, different, store.port, options)).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
      expect(backend.calls).toEqual(['close']);
    }
    const wrongTarget = transport(binding, { target: { ...target, namespace: 'other' } });
    await expect(performArtifactOperation(wrongTarget.port, binding, journal().port, options)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' });
    expect(wrongTarget.calls).toEqual(['close']);
  });

  it('uses atomic journal occupation to prevent concurrent duplicate mutation', async () => {
    const binding = await bindArtifactOperation(input), store = journal();
    let writes = 0;
    const create = () => transport(binding, { async execute() { writes++; return { state: 'accepted', reference: 'dep-1' }; } }).port;
    const results = await Promise.allSettled([performArtifactOperation(create(), binding, store.port, options), performArtifactOperation(create(), binding, store.port, options)]);
    expect(writes).toBe(1);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  });

  it('never executes after an unknown or conflicting journal claim', async () => {
    const binding = await bindArtifactOperation(input);
    for (const compareAndSet of [async () => { throw Error('database-secret'); }, async () => 'conflict' as const]) {
      const backend = transport(binding);
      const failure = await performArtifactOperation(backend.port, binding, { async load() { return undefined; }, compareAndSet }, options).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: expect.stringMatching(/JOURNAL_UNKNOWN|JOURNAL_CONFLICT/u) });
      expect(backend.calls).toEqual(['close']);
      expect(JSON.stringify(failure)).not.toContain('database-secret');
    }
  });

  it('rejects unsupported capabilities and inconsistent remote identities', async () => {
    const binding = await bindArtifactOperation(input);
    const unsupported = transport(binding, { capability: 'artifact-upload' });
    await expect(performArtifactOperation(unsupported.port, binding, journal().port, options)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    const wrong = transport(binding, { async observe() { return { state: 'succeeded', fingerprint: 'e'.repeat(64), reference: 'dep-1' }; } });
    await expect(performArtifactOperation(wrong.port, binding, journal().port, options)).rejects.toMatchObject({ code: 'OBSERVATION_MISMATCH' });
    const different = transport(binding, { async observe() { return { state: 'succeeded', fingerprint: binding.fingerprint, reference: 'dep-2' }; } });
    await expect(performArtifactOperation(different.port, binding, journal().port, options)).rejects.toMatchObject({ code: 'OBSERVATION_MISMATCH' });
  });

  it('records explicit provider rejection without invoking observation', async () => {
    const binding = await bindArtifactOperation(input), store = journal();
    const backend = transport(binding, { async execute() { return { state: 'rejected', code: 'ACCESS_REFUSED' }; } });
    await expect(performArtifactOperation(backend.port, binding, store.port, options)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED', receipt: { outcome: 'failed', record: { writeState: 'rejected', attemptFailure: 'ACCESS_REFUSED' } } });
    expect(backend.calls).toEqual(['close']);
  });

  it('closes on validation failure and rejects reuse of a consumed transport', async () => {
    const binding = await bindArtifactOperation(input), backend = transport(binding);
    await expect(performArtifactOperation(backend.port, binding, journal().port, { ...options, timeoutMilliseconds: 0 })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(backend.calls).toEqual(['close']);
    await expect(performArtifactOperation(backend.port, binding, journal().port, options)).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
    expect(backend.calls).toEqual(['close']);
  });

  it('retains unknown side effects and closure when a provider ignores cancellation', async () => {
    const binding = await bindArtifactOperation(input), store = journal();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const backend = transport(binding, { async execute() { await pending; return { state: 'accepted' }; },
      async close() { return { status: 'closed', activeRequests: 0 }; } });
    try {
      await expect(performArtifactOperation(backend.port, binding, store.port, { timeoutMilliseconds: 20, closeTimeoutMilliseconds: 10 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', receipt: { record: { writeState: 'unknown' }, closure: { status: 'unconfirmed', activeRequests: 1 } } });
    } finally { finish?.(); }
    expect(store.read()?.writeState).toBe('unknown');
  });

  it('cancels before dispatch and never replaces the original provider failure with a close failure', async () => {
    const binding = await bindArtifactOperation(input), controller = new AbortController();
    controller.abort();
    const backend = transport(binding);
    await expect(performArtifactOperation(backend.port, binding, journal().port, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(backend.calls).toEqual(['close']);
    const failed = transport(binding, { async execute() { throw Error('failure'); }, async close() { throw Error('cleanup-secret'); } });
    await expect(performArtifactOperation(failed.port, binding, journal().port, options)).rejects.toMatchObject({ code: 'PROVIDER_FAILED', receipt: { closure: { status: 'unconfirmed' } } });
  });

  it('canonicalizes input order, snapshots values and validates descriptor bounds', async () => {
    const second = { name: 'image', sha256: 'd'.repeat(64), byteLength: 7 };
    const a = await bindArtifactOperation({ ...input, inputs: [...input.inputs, second] });
    const b = await bindArtifactOperation({ ...input, inputs: [second, ...input.inputs] });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.inputs.map(value => value.name)).toEqual(['image', 'static']);
    for (const inputs of [[], new Array<typeof second>(1), [...input.inputs, ...input.inputs], [{ ...second, byteLength: -1 }]]) {
      await expect(bindArtifactOperation({ ...input, inputs })).rejects.toMatchObject({ code: 'INVALID_BINDING' });
    }
  });

  it('returns the attempted durable claim as unknown if its acknowledgement is lost', async () => {
    const binding = await bindArtifactOperation(input), store = journal();
    const backend = transport(binding);
    await expect(performArtifactOperation(backend.port, binding, { ...store.port,
      async compareAndSet(value, context) { await store.port.compareAndSet(value, context); throw Error('lost journal reply'); },
    }, options)).rejects.toMatchObject({ code: 'JOURNAL_UNKNOWN', receipt: { journalState: 'unknown', record: { revision: 1, writeState: 'unknown' } } });
    expect(backend.calls).toEqual(['close']);
    expect((await observeArtifactOperation(transport(binding).port, binding, store.port, options)).outcome).toBe('succeeded');
  });

  it('does not return success when cancellation arrives during resource close', async () => {
    const binding = await bindArtifactOperation(input), controller = new AbortController();
    const backend = transport(binding, { async close() { controller.abort(Error('private reason')); return { status: 'closed', activeRequests: 0 }; } });
    await expect(performArtifactOperation(backend.port, binding, journal().port, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  });
});
