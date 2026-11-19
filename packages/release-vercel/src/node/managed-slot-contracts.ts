import type { PrebuiltReleaseState, ReleaseCompletionState } from '../contracts.js';
import type { OwnedLock } from './lock.js';
import type { LocalDirectoryLease } from '@openge/forge-process-control-node';
import type { RetirementHost } from './retirement-host.js';
import type { CompletionInputBinding, FrozenSource, ManagedAnchor, ManagedPaths, ManagedReceipt, ManagedState, MetadataFile, RecordedIdentity } from './managed-state-contracts.js';

export interface ManagedStateStore {
  read(): Promise<ManagedState | undefined>;
  writeState(state: ManagedState, beforeCommit?: (prepared: MetadataFile) => Promise<void>): Promise<void>;
  readReceipt(kind: 'check' | 'publish'): Promise<ManagedReceipt | undefined>;
  writeReceipt(kind: 'check' | 'publish', receipt: ManagedReceipt, mode?: 'observation-deadline'): Promise<void>;
  writeAnchor(anchor: ManagedAnchor): Promise<void>;
}
export interface ManagedSlot {
  readonly slotId: string; readonly paths: ManagedPaths; readonly source: FrozenSource;
  readonly lock: OwnedLock; readonly store: ManagedStateStore;
  assertMetadataOwned(): Promise<void>;
  readonly runId: string; readonly coordinator: RecordedIdentity;
  readonly coordinatorLease?: LocalDirectoryLease & { readonly host: RetirementHost };
  readonly completionResume?: { readonly prebuilt: PrebuiltReleaseState; readonly completion: ReleaseCompletionState; readonly input: CompletionInputBinding };
}
