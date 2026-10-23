import { verifyBytesIntegrity } from '@openge/forge-artifact-integrity';
import type {
  ArtifactActivationPlan, ArtifactObjectDescriptor, ArtifactPublicationFailure,
  ArtifactPublicationOptions, ArtifactPublicationPhase, ArtifactPublicationReceipt,
  ArtifactPublicationTransport, ArtifactReleasePlan, ArtifactTransportClosure,
} from './contracts.js';
import { OperationBudget } from './budget.js';
import { ArtifactPublicationError } from './errors.js';
import { createReceipt, type ReceiptDraft } from './receipt.js';
import { claimTransport, closeTransport, finishTransportUse } from './transport-lifetime.js';
import { snapshotPlan, snapshotTarget, validateOptions } from './validation.js';

async function verifyBytes(value: ArtifactObjectDescriptor, bytes: Uint8Array): Promise<void> {
  try { await verifyBytesIntegrity(bytes, value); }
  catch { throw new ArtifactPublicationError('INTEGRITY_MISMATCH'); }
}

async function verifyRemote(transport: ArtifactPublicationTransport, value: ArtifactObjectDescriptor, budget: OperationBudget): Promise<void> {
  const remote = await budget.run(() => transport.readObject({ key: value.key, maxBytes: value.byteLength }, budget.context()));
  await budget.run(() => verifyBytes(value, remote.bytes), false);
  if (remote.contentType !== value.contentType || remote.cacheControl !== value.cacheControl) {
    throw new ArtifactPublicationError('METADATA_MISMATCH');
  }
}

function failureOf(error: unknown, phase: ArtifactPublicationPhase, key: string | undefined): ArtifactPublicationFailure {
  const failedKey = key ?? (error instanceof ArtifactPublicationError ? error.key : undefined);
  return {
    code: error instanceof ArtifactPublicationError ? error.code : 'TRANSPORT_FAILED',
    phase,
    ...(failedKey ? { key: failedKey } : {}),
    ...(error instanceof ArtifactPublicationError && error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
  };
}

type PreparePlan = (budget: OperationBudget) => Promise<ArtifactReleasePlan>;
type PlanSource = { readonly input: ArtifactActivationPlan }
  | { readonly snapshot: (options: ArtifactPublicationOptions) => PreparePlan };

async function run(
  transport: ArtifactPublicationTransport,
  source: PlanSource,
  inputOptions: ArtifactPublicationOptions,
  operation: 'publish' | 'activate',
): Promise<ArtifactPublicationReceipt> {
  claimTransport(transport);
  let receipt: ReceiptDraft | undefined;
  let failure: ArtifactPublicationFailure | undefined;
  let options: ArtifactPublicationOptions | undefined;
  let phase: ArtifactPublicationPhase = 'validation';
  let key: string | undefined;
  let budget: OperationBudget | undefined;
  let closure: ArtifactTransportClosure;
  const recordFailure = (error: unknown, failedPhase: ArtifactPublicationPhase, failedKey: string | undefined) => {
    failure ??= failureOf(error, failedPhase, failedKey);
    budget?.stop(new ArtifactPublicationError(failure.code));
  };
  try {
    options = validateOptions(inputOptions);
    budget = new OperationBudget(options);
    budget.assertActive();
    const target = snapshotTarget(transport.target);
    const currentBudget = budget;
    let input: ArtifactActivationPlan;
    if ('input' in source) input = source.input;
    else {
      const prepare = source.snapshot(options);
      input = await budget.run(() => prepare(currentBudget));
    }
    const { plan, uploads } = snapshotPlan(input, options, operation);
    receipt = createReceipt(target, plan, options, operation);
    for (const value of [...(uploads ?? []), plan.pointer]) {
      key = value.key;
      await budget.run(() => verifyBytes(value, value.bytes), false);
    }
    phase = 'prepare';
    key = undefined;
    await budget.run(() => transport.prepare(currentBudget.context()));
    phase = 'objects';
    let nextIndex = 0;
    const currentReceipt = receipt;
    const worker = async () => {
      while (!failure && nextIndex < plan.objects.length) {
        const index = nextIndex++;
        const value = plan.objects[index];
        const entry = currentReceipt.objects[index];
        if (!value || !entry) {
          recordFailure(new ArtifactPublicationError('INVALID_PLAN'), 'objects', undefined);
          return;
        }
        try {
          currentBudget.assertActive();
          const upload = uploads?.[index];
          if (upload) {
            entry.writeState = 'unknown';
            const result = await currentBudget.run(() => transport.createObject(upload, currentBudget.context()));
            entry.writeState = result === 'created' ? 'accepted' : 'already-exists';
          }
          await verifyRemote(transport, value, currentBudget);
          entry.verificationState = 'succeeded';
        } catch (error) {
          entry.verificationState = 'failed';
          recordFailure(error, 'objects', value.key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, plan.objects.length) }, worker));
    budget.assertActive();
    phase = 'pointer';
    key = plan.pointer.key;
    const pointer = receipt.pointer;
    pointer.writeState = 'unknown';
    await budget.run(() => transport.replaceObject(plan.pointer, currentBudget.context()));
    pointer.writeState = 'accepted';
    await verifyRemote(transport, plan.pointer, budget);
    pointer.verificationState = 'succeeded';
  } catch (error) {
    recordFailure(error, phase, key);
    if (phase === 'pointer' && receipt) receipt.pointer.verificationState = 'failed';
  } finally {
    budget?.endTransfers();
    closure = await closeTransport(transport, options?.closeTimeoutMilliseconds ?? 1_000,
      () => budget?.pendingRequests ?? 0, async () => { await budget?.settleRequests(); });
    if (!failure && budget?.reason) failure = failureOf(budget.reason, 'close', undefined);
    budget?.dispose();
    finishTransportUse(transport);
    if (closure.status !== 'closed' || closure.activeRequests !== 0) {
      failure ??= { code: 'CLOSURE_UNCONFIRMED', phase: 'close' };
    }
    if (receipt) receipt.closure = closure;
  }
  if (failure) {
    if (receipt) receipt.failure = failure;
    throw new ArtifactPublicationError(failure.code, { ...failure, closure, ...(receipt ? { receipt } : {}) });
  }
  if (!receipt) throw new ArtifactPublicationError('INVALID_PLAN', { closure });
  receipt.outcome = 'succeeded';
  return receipt;
}

export const publishArtifactRelease = (
  transport: ArtifactPublicationTransport,
  plan: ArtifactReleasePlan,
  options: ArtifactPublicationOptions,
): Promise<ArtifactPublicationReceipt> => run(transport, { input: plan }, options, 'publish');

export const activateArtifactRelease = (
  transport: ArtifactPublicationTransport,
  plan: ArtifactActivationPlan,
  options: ArtifactPublicationOptions,
): Promise<ArtifactPublicationReceipt> => run(transport, { input: plan }, options, 'activate');

// 文件适配器在同一预算和资源所有权下准备快照，不新增公开回调入口。
export const publishPreparedArtifactRelease = (
  transport: ArtifactPublicationTransport,
  options: ArtifactPublicationOptions,
  snapshot: (options: ArtifactPublicationOptions) => PreparePlan,
): Promise<ArtifactPublicationReceipt> => run(transport, { snapshot }, options, 'publish');
