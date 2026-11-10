import { OperationBudget } from '../budget.js';
import type { ArtifactTransportClosure } from '../contracts.js';
import { ArtifactPublicationError } from '../errors.js';
import { claimTransport, closeTransport, finishTransportUse } from '../transport-lifetime.js';
import { operationCode, operationReference, snapshotOperationBinding } from './binding.js';
import type { ArtifactOperationBinding, ArtifactOperationErrorCode, ArtifactOperationJournal,
  ArtifactOperationObserver, ArtifactOperationOptions, ArtifactOperationReceipt, ArtifactOperationRecord, ArtifactOperationTransport } from './contracts.js';
import { ArtifactOperationError } from './errors.js';
import { observationStates, operationOptions, requireOperationTarget, snapshotOperationRecord } from './validation.js';

function errorCode(error: unknown, fallback: ArtifactOperationErrorCode): ArtifactOperationErrorCode {
  if (error instanceof ArtifactOperationError) return error.code;
  if (error instanceof ArtifactPublicationError && ['OPERATION_ABORTED', 'BUDGET_EXCEEDED', 'TRANSPORT_IN_USE', 'TRANSPORT_CLOSED'].includes(error.code)) {
    switch (error.code) {
      case 'OPERATION_ABORTED': return 'OPERATION_ABORTED';
      case 'BUDGET_EXCEEDED': return 'BUDGET_EXCEEDED';
      case 'TRANSPORT_IN_USE': return 'TRANSPORT_IN_USE';
      case 'TRANSPORT_CLOSED': return 'TRANSPORT_CLOSED';
    }
  }
  return fallback;
}

type OperationSource = { readonly mode: 'perform'; readonly transport: ArtifactOperationTransport }
  | { readonly mode: 'observe'; readonly transport: ArtifactOperationObserver };

async function runOperation(source: OperationSource, input: ArtifactOperationBinding,
  journal: ArtifactOperationJournal, inputOptions: ArtifactOperationOptions): Promise<ArtifactOperationReceipt> {
  const { transport, mode } = source;
  try { claimTransport(transport); }
  catch (error) { throw new ArtifactOperationError(errorCode(error, 'INVALID_BINDING')); }
  let budget: OperationBudget | undefined;
  let options: ArtifactOperationOptions | undefined;
  let record: ArtifactOperationRecord | undefined;
  let attemptedRecord: ArtifactOperationRecord | undefined;
  let journalState: 'confirmed' | 'unknown' = 'confirmed';
  let failure: ArtifactOperationErrorCode | undefined;
  let closure: ArtifactTransportClosure;
  let fallback: ArtifactOperationErrorCode = 'INVALID_BINDING';
  try {
    options = operationOptions(inputOptions);
    budget = new OperationBudget(options);
    const currentBudget = budget;
    const binding = await budget.run(() => snapshotOperationBinding(input), false);
    requireOperationTarget(transport, binding);
    if (!journal || typeof journal.load !== 'function' || typeof journal.compareAndSet !== 'function') {
      throw new ArtifactOperationError('INVALID_JOURNAL');
    }
    fallback = 'JOURNAL_UNKNOWN';
    const saved = await budget.run(() => journal.load(binding.requestId, currentBudget.context()));
    if (saved !== undefined) record = await budget.run(() => snapshotOperationRecord(saved, binding), false);
    if (mode === 'perform' && record) throw new ArtifactOperationError('RECOVERY_REQUIRED');
    if (mode === 'observe' && !record) throw new ArtifactOperationError('OPERATION_MISSING');

    const persist = async (next: ArtifactOperationRecord, expectedRevision: number) => {
      fallback = 'JOURNAL_UNKNOWN';
      // 发出 CAS 前即标为未知，拒绝、丢响应和超时都不能被误认为占位成功。
      journalState = 'unknown';
      attemptedRecord = next;
      const result = await currentBudget.run(() => journal.compareAndSet({ expectedRevision, next }, currentBudget.context()));
      if (result !== 'stored') throw new ArtifactOperationError(result === 'conflict' ? 'JOURNAL_CONFLICT' : 'INVALID_RESPONSE');
      record = next;
      attemptedRecord = undefined;
      journalState = 'confirmed';
    };

    if (source.mode === 'perform') {
      const claim: ArtifactOperationRecord = Object.freeze({ schemaVersion: 1, revision: 1, binding,
        writeState: 'unknown', observation: 'unknown' });
      await persist(claim, 0);
      fallback = 'PROVIDER_FAILED';
      try {
        const acknowledgement = await budget.run(() => source.transport.execute(binding, currentBudget.context()));
        if (!acknowledgement || !['accepted', 'rejected'].includes(acknowledgement.state)) throw new ArtifactOperationError('INVALID_RESPONSE');
        if (acknowledgement.state === 'rejected') {
          if (!operationCode(acknowledgement.code)) throw new ArtifactOperationError('INVALID_RESPONSE');
          await persist(Object.freeze({ ...claim, revision: 2, writeState: 'rejected', attemptFailure: acknowledgement.code }), 1);
          throw new ArtifactOperationError('PROVIDER_REJECTED');
        }
        if (acknowledgement.reference !== undefined && !operationReference(acknowledgement.reference)) throw new ArtifactOperationError('INVALID_RESPONSE');
        await persist(Object.freeze({ ...claim, revision: 2, writeState: 'accepted',
          ...(acknowledgement.reference !== undefined ? { reference: acknowledgement.reference } : {}) }), 1);
      } catch (error) {
        const code = errorCode(error, fallback);
        // 预算到期或存储未知后不能再启动 journal 写入；原始占位足以阻止重放。
        if (record?.revision === 1 && journalState === 'confirmed' && !budget.reason) {
          try { await persist(Object.freeze({ ...record, revision: 2, attemptFailure: code }), 1); }
          catch { /* 保留原错误；journalState 仍记录持久化未知。 */ }
        }
        throw new ArtifactOperationError(code);
      }
    }
    if (!record) throw new ArtifactOperationError('OPERATION_MISSING');
    const current = record;
    fallback = 'PROVIDER_FAILED';
    const observed = await budget.run(() => transport.observe(binding, current.reference, currentBudget.context()));
    if (!observed || !observationStates.includes(observed.state)
      || (observed.reference !== undefined && !operationReference(observed.reference))) throw new ArtifactOperationError('INVALID_RESPONSE');
    if (observed.fingerprint !== binding.fingerprint
      || (current.reference !== undefined && observed.reference !== undefined && observed.reference !== current.reference)
      || (observed.state === 'succeeded' && observed.reference === undefined)) throw new ArtifactOperationError('OBSERVATION_MISMATCH');
    await persist(Object.freeze({ ...current, revision: current.revision + 1, observation: observed.state,
      ...(observed.reference !== undefined ? { reference: observed.reference } : {}) }), current.revision);
  } catch (error) {
    failure = errorCode(error, fallback);
  } finally {
    budget?.endTransfers();
    closure = await closeTransport(transport, options?.closeTimeoutMilliseconds ?? 1_000,
      () => budget?.pendingRequests ?? 0, async () => { await budget?.settleRequests(); });
    if (budget?.reason) failure ??= errorCode(budget.reason, 'PROVIDER_FAILED');
    budget?.dispose();
    finishTransportUse(transport);
    if (closure.status !== 'closed' || closure.activeRequests !== 0) failure ??= 'CLOSURE_UNCONFIRMED';
  }
  const rejected = failure === 'PROVIDER_REJECTED' && journalState === 'confirmed' && closure.status === 'closed';
  const outcome = rejected ? 'failed' : failure ? 'unknown' : record?.observation === 'succeeded' ? 'succeeded'
    : record?.observation === 'pending' ? 'pending' : record?.observation === 'failed' ? 'failed' : 'unknown';
  const lastRecord = attemptedRecord ?? record;
  const receipt: ArtifactOperationReceipt | undefined = lastRecord ? { outcome, record: lastRecord, journalState, closure } : undefined;
  if (failure) throw new ArtifactOperationError(failure, { closure, ...(receipt ? { receipt } : {}) });
  if (!receipt) throw new ArtifactOperationError('OPERATION_MISSING', { closure });
  return receipt;
}

export const performArtifactOperation = (transport: ArtifactOperationTransport, binding: ArtifactOperationBinding,
  journal: ArtifactOperationJournal, options: ArtifactOperationOptions): Promise<ArtifactOperationReceipt> =>
  runOperation({ mode: 'perform', transport }, binding, journal, options);

export const observeArtifactOperation = (transport: ArtifactOperationObserver, binding: ArtifactOperationBinding,
  journal: ArtifactOperationJournal, options: ArtifactOperationOptions): Promise<ArtifactOperationReceipt> =>
  runOperation({ mode: 'observe', transport }, binding, journal, options);
