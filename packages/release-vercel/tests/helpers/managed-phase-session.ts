import { randomUUID } from 'node:crypto';
import type { ManagedReceipt } from '../../src/node/release-context.js';
import { createManagedSession } from '../../src/node/managed-process.js';
import { createManagedStateStore } from '../../src/node/managed-state.js';
import { archiveManagedDisposition } from '../../src/node/managed-disposition.js';
import { acquireLock } from '../../src/node/lock.js';
import { managedSessionFixture } from './managed-session-fixture.js';
import { prebuiltCandidateContext } from '../../src/node/version-alias.js';

/** 真实目录、锁与状态事务；空命令集合只是阶段输入，不代表任何OS进程已停止。 */
export async function managedPhaseSession(options?: Parameters<typeof managedSessionFixture>[0], signal?: AbortSignal) {
  const base = await managedSessionFixture(options);
  let lock = base.slot.lock;
  let session: Awaited<ReturnType<typeof createManagedSession>>;
  try { session = await createManagedSession(base.slot, 'publish', signal); }
  catch (error) { await lock.release(); await base.dispose(); throw error; }
  const report = (ok: boolean): ManagedReceipt => {
    const candidateContext = prebuiltCandidateContext(session.slot.source.config, session.state.prebuilt);
    return { schemaVersion: 2, slotId: session.slot.slotId, source: session.slot.source,
    report: { schemaVersion: 2, command: session.state.command, ok, runId: session.state.runId, candidateSha: session.slot.source.sha,
      sourceRoot: base.cwd, configPath: session.slot.source.configPath, configSha256: session.slot.source.configSha256,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stage: session.state.stage, steps: [],
      effects: structuredClone(session.state.effects), ...(session.state.prebuilt ? { prebuilt: structuredClone(session.state.prebuilt) } : {}),
      ...(session.state.completion ? { completion: structuredClone(session.state.completion) } : {}),
      ...(candidateContext ? { candidateContext } : {}),
      ...(!ok ? { error: { code: 'VERCEL_API', details: { reason: 'PHASE_INPUT' } } } : {}) } };
  };
  const archive = async (ok: boolean) => {
    session.state.status = 'closed'; await session.persist();
    const receipt = report(ok);
    if (session.state.command === 'publish') await session.slot.store.writeReceipt('publish', receipt);
    await archiveManagedDisposition(session.slot.paths, session.state, session.state, () => lock.assertOwned(), undefined, false, receipt.report);
    return receipt;
  };
  const next = async (command: Parameters<typeof createManagedSession>[1], sha = base.sha) => {
    await lock.release();
    const runId = randomUUID(), source = { ...base.source, sha };
    lock = await acquireLock(base.slot.paths.lockPath, { runId, identity: base.slot.coordinator });
    const guard = () => lock.assertOwned();
    const slot = { ...base.slot, source, runId, lock, assertMetadataOwned: guard,
      store: createManagedStateStore(base.slot.paths, source, base.slot.slotId, guard) };
    session = await createManagedSession(slot, command, signal); return session;
  };
  return { ...base, get session() { return session; }, archive, next, report,
    dispose: async () => { try { await lock.release(); } finally { await base.dispose(); } } };
}
