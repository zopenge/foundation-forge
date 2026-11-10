import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { activateArtifactRelease, bindArtifactOperation, observeArtifactOperation, performArtifactOperation } from '@openge/forge-artifact-publish';

// 目录消费者沿用真实 COS 协议，操作日志只包围明确的 current 激活事实。
export async function verifyDurableActivation({ fixture, transport, plan, options }) {
  let saved;
  const journal = {
    async load() { return saved; },
    async compareAndSet({ expectedRevision, next }) {
      if ((saved?.revision ?? 0) !== expectedRevision) return 'conflict';
      saved = globalThis.structuredClone(next); return 'stored';
    },
  };
  const probe = transport();
  const target = probe.target;
  await probe.close({ timeoutMilliseconds: 2_000 });
  const binding = await bindArtifactOperation({ requestId: 'catalog-v1', sourceCommit: plan.sourceCommit,
    target, capability: 'activation', configurationSha256: 'c'.repeat(64),
    inputs: [{ name: plan.pointer.key, sha256: plan.pointer.sha256, byteLength: plan.pointer.byteLength }] });
  const adapter = loseResponse => {
    const reader = transport();
    let publicationClosure = { status: 'closed', activeRequests: 0 };
    return {
      target, capability: 'activation', configurationSha256: binding.configurationSha256,
      async execute() {
        assert.equal(saved.writeState, 'unknown');
        const receipt = await activateArtifactRelease(transport(), plan, options);
        publicationClosure = receipt.closure;
        if (loseResponse) throw Error('synthetic lost reply');
        return { state: 'accepted', reference: plan.pointer.key };
      },
      async observe(selected, reference, context) {
        assert.equal(reference ?? plan.pointer.key, plan.pointer.key);
        assert.equal(selected.sourceCommit, plan.sourceCommit);
        await reader.prepare(context);
        const remote = await reader.readObject({ key: plan.pointer.key, maxBytes: plan.pointer.byteLength }, context);
        assert.equal(createHash('sha256').update(remote.bytes).digest('hex'), plan.pointer.sha256);
        assert.equal(remote.bytes.byteLength, plan.pointer.byteLength);
        assert.equal(remote.cacheControl, plan.pointer.cacheControl);
        return { state: 'succeeded', fingerprint: selected.fingerprint, reference: plan.pointer.key };
      },
      async close(limits) {
        const closure = await reader.close(limits);
        assert.equal(publicationClosure.status, 'closed');
        return closure;
      },
    };
  };
  const limits = { timeoutMilliseconds: 10_000, closeTimeoutMilliseconds: 2_000 };
  await assert.rejects(performArtifactOperation(adapter(true), binding, journal, limits), { code: 'PROVIDER_FAILED' });
  const writes = fixture.requests.filter(value => value.method === 'PUT').length;
  const recovered = await observeArtifactOperation(adapter(false), binding, journal, limits);
  assert.equal(recovered.outcome, 'succeeded');
  assert.equal(recovered.record.writeState, 'unknown');
  assert.equal(recovered.record.attemptFailure, 'PROVIDER_FAILED');
  assert.equal(fixture.requests.filter(value => value.method === 'PUT').length, writes);
  await assert.rejects(performArtifactOperation(adapter(false), binding, journal, limits), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fixture.requests.filter(value => value.method === 'PUT').length, writes);
}
