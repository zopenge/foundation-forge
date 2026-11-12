import { DurableObject } from 'cloudflare:workers';
import { bindArtifactOperation, createArtifactContentManifest, observeArtifactOperation,
  performArtifactOperation } from '@openge/forge-artifact-publish';

const { URL, Response, AbortController } = globalThis;

const assert = (condition, message) => { if (!condition) throw Error(message); };
const target = { provider: 'sqlite-fixture', namespace: 'artifacts', endpoint: 'https://storage.invalid' };
const options = { timeoutMilliseconds: 10_000, closeTimeoutMilliseconds: 2_000 };

// 仅为包消费 fixture；产品的持久适配、阶段状态及调度仍由消费者持有。
export class Journal extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this.db.exec('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, revision INTEGER, record TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS counts (name TEXT PRIMARY KEY, value INTEGER)');
  }
  count(name, add = 0) {
    if (add) this.db.exec('INSERT INTO counts VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value', name, add);
    return this.db.exec('SELECT value FROM counts WHERE name = ?', name).toArray()[0]?.value ?? 0;
  }
  read(id) {
    const row = this.db.exec('SELECT record FROM operations WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.record) : undefined;
  }
  journal(loseClaim) {
    return {
      load: async (id, context) => { context.signal.throwIfAborted(); return this.read(id); },
      compareAndSet: async ({ expectedRevision, next }, context) => {
        context.signal.throwIfAborted();
        const result = this.ctx.storage.transactionSync(() => {
          if ((this.read(next.binding.requestId)?.revision ?? 0) !== expectedRevision) return 'conflict';
          this.db.exec('INSERT INTO operations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, record = excluded.record',
            next.binding.requestId, next.revision, JSON.stringify(next));
          return 'stored';
        });
        await this.ctx.storage.sync();
        if (loseClaim && expectedRevision === 0 && result === 'stored') throw Error('fixture lost CAS acknowledgement');
        context.signal.throwIfAborted();
        return result;
      },
    };
  }
  async fetch(request) {
    const url = new URL(request.url), id = url.searchParams.get('id') ?? 'normal';
    if (url.pathname === '/stats') return Response.json({ effects: this.count('effects'), observations: this.count('observations') });
    const prepared = await createArtifactContentManifest({ schemaVersion: 1, files: [{ path: 'a.bin', role: 'asset',
      byteLength: 1, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      responseHeaders: { 'content-type': 'application/octet-stream', 'cache-control': 'no-cache' } }] });
    const binding = await bindArtifactOperation({ requestId: 'worker-' + id, content: prepared.content, target,
      capability: 'deployment-ready', configurationSha256: 'b'.repeat(64),
      inputs: [{ name: 'content-manifest.json', sha256: prepared.content.manifestSha256, byteLength: prepared.bytes.byteLength }] });
    const observer = {
      target, capability: binding.capability, configurationSha256: binding.configurationSha256,
      observe: async (selected, reference) => {
        const observations = this.count('observations', 1);
        assert(reference === undefined || reference === 'artifact-' + id, 'reference changed');
        return { state: this.count('effects') === 0 ? 'absent' : observations >= 3 ? 'succeeded' : 'pending',
          fingerprint: selected.fingerprint, ...(this.count('effects') ? { reference: 'artifact-' + id } : {}) };
      },
      close: async () => ({ status: url.pathname === '/unconfirmed' ? 'unconfirmed' : 'closed',
        activeRequests: url.pathname === '/unconfirmed' ? 1 : 0 }),
    };
    const transport = { ...observer, execute: async selected => {
      const claim = this.read(selected.requestId);
      assert(claim?.schemaVersion === 2 && claim.writeState === 'unknown' && claim.binding.fingerprint === selected.fingerprint,
        'effect dispatched before confirmed occupation');
      this.count('effects', 1);
      return { state: 'accepted', reference: 'artifact-' + id };
    } };
    if (url.pathname === '/legacy') {
      this.db.exec('INSERT OR REPLACE INTO operations VALUES (?, ?, ?)', binding.requestId, 1,
        JSON.stringify({ schemaVersion: 1, revision: 1, binding, writeState: 'unknown', observation: 'unknown' }));
    }
    const cancelled = new AbortController();
    if (url.pathname === '/cancel') cancelled.abort();
    try {
      const receipt = await (['/observe', '/legacy'].includes(url.pathname)
        ? observeArtifactOperation(observer, binding, this.journal(false), options)
        : performArtifactOperation(transport, binding, this.journal(url.pathname === '/lost-claim'),
          { ...options, ...(url.pathname === '/cancel' ? { signal: cancelled.signal } : {}) }));
      return Response.json({ receipt, effects: this.count('effects'), observations: this.count('observations'),
        nodeGlobals: [typeof globalThis.process, typeof globalThis.Buffer] });
    } catch (error) {
      return Response.json({ code: error.code, receipt: error.receipt, closure: error.closure,
        effects: this.count('effects'), observations: this.count('observations') });
    }
  }
}

export default {
  fetch(request, env) {
    const id = new URL(request.url).searchParams.get('id') ?? 'normal';
    return env.JOURNAL.get(env.JOURNAL.idFromName(id)).fetch(request);
  },
};
