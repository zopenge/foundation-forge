import type { ReleaseCommand, ReleaseConfig, ReleaseReport, ReleaseStage, ReleaseTransport } from '../contracts.js';
import type { OwnedLock } from './lock.js';
import type { CommandObserver, CommandResult, CommandRunner, CommandSpec, CommandTerminationReason } from '@openge/forge-command-runner';
import type { ProcessScopeClosure } from '@openge/forge-process-control';
import type { Execution } from './execution.js';
import type { RetirementHost } from './retirement-host.js';
import type { BudgetMonitor } from './managed-budget.js';

export interface FrozenSource {
  readonly root: string;
  readonly sha: string;
  readonly configPath: string;
  readonly config: ReleaseConfig;
  readonly configBlobOid: string;
  readonly configSha256: string;
  readonly fetchUrl: string;
}
export interface FileIdentity { readonly dev: string; readonly ino: string }
export interface MetadataFile { readonly identity: FileIdentity; readonly sha256: string }
export interface ManagedHistoryReference { readonly path: string; readonly file: { readonly identity: FileIdentity; readonly sha256: string } }
export interface ManagedPaths {
  readonly sourceRoot: string; readonly slotRoot: string; readonly checkoutRoot: string;
  readonly anchorPath: string; readonly ownershipPath: string; readonly statePath: string;
  readonly lockPath: string; readonly recoveryLockPath: string;
  readonly sourceIdentity: FileIdentity; readonly slotIdentity: FileIdentity;
}
export interface RecordedIdentity { readonly pid: number; readonly startToken: string }
export interface ManagedCommand {
  readonly id: string; readonly name: string;
  readonly kind?: 'checkout-observation';
  readonly plan?: readonly { readonly name: string; readonly args: readonly string[] }[];
  observations?: ManagedCommand[];
  status: 'intent' | 'spawned' | 'identified' | 'closed' | 'stopped' | 'unknown';
  pid?: number; identity?: RecordedIdentity;
  descendants: RecordedIdentity[];
  observationComplete: boolean;
  scope?: { readonly scopeId: string; readonly binding: string };
  terminalSha256?: string;
  closure?: { readonly observedAt: string; readonly exitCode: number | null; readonly termination: CommandTerminationReason; readonly requestedTermination?: 'abort' | 'timeout'; readonly ownedScope?: ProcessScopeClosure };
}
export interface ManagedState {
  readonly schemaVersion: 2 | 3; readonly slotId: string; readonly runId: string;
  readonly source: FrozenSource; readonly command: ReleaseCommand;
  readonly coordinator: RecordedIdentity;
  readonly host?: RetirementHost;
  readonly history?: readonly ManagedHistoryReference[];
  stage: ReleaseStage; status: 'running' | 'closed' | 'unknown';
  processes: ManagedCommand[];
  effects: ReleaseReport['effects'];
  pendingPush?: 'developmentPush' | 'releasePush';
}
export interface ManagedReceipt { readonly schemaVersion: 2; readonly slotId: string; readonly source: FrozenSource; readonly report: ReleaseReport }
export interface ManagedAnchor {
  readonly schemaVersion: 2; readonly slotId: string; readonly slotPath: string; readonly configPath: string;
  readonly sourceRoot: string;
  readonly latestPublish?: { readonly sha: string; readonly runId: string; readonly configSha256: string };
}
export interface ManagedStateStore {
  read(): Promise<ManagedState | undefined>;
  writeState(state: ManagedState, beforeCommit?: (prepared: MetadataFile) => Promise<void>): Promise<void>;
  readReceipt(kind: 'check' | 'publish'): Promise<ManagedReceipt | undefined>;
  writeReceipt(kind: 'check' | 'publish', receipt: ManagedReceipt): Promise<void>;
  writeAnchor(anchor: ManagedAnchor): Promise<void>;
}
export interface ManagedSlot {
  readonly slotId: string; readonly paths: ManagedPaths; readonly source: FrozenSource;
  readonly lock: OwnedLock; readonly store: ManagedStateStore;
  assertMetadataOwned(): Promise<void>;
  readonly runId: string; readonly coordinator: RecordedIdentity;
}
export interface ExecutionLifecycle {
  execute(runner: CommandRunner, name: string, spec: CommandSpec, observer?: CommandObserver): Promise<CommandResult>;
  observeCheckout?<T>(operation: () => Promise<T>): Promise<T>;
}
export interface ManagedSession {
  readonly slot: ManagedSlot;
  readonly command: 'check' | 'publish' | 'verify';
  readonly state: ManagedState;
  readonly budget: BudgetMonitor;
  readonly execution: Execution;
  readonly steps: ReleaseReport['steps'];
  persist(): Promise<void>;
  assertClosed(): Promise<void>;
  assertStopped(): Promise<void>;
  executionAt(cwd: string): Execution;
}
export interface ExecutionContext {
  readonly execution: Execution; readonly config: ReleaseConfig; readonly sha: string;
  readonly signal: AbortSignal | undefined; readonly transport: ReleaseTransport | undefined;
  readonly effects: ReleaseReport['effects'];
  assertFrozen(): Promise<void>;
  mutationGuard(effect?: 'developmentPush' | 'releasePush'): Promise<'already-current' | undefined>;
  stage(stage: ReleaseStage): Promise<void>;
  checkpoint(pending?: 'developmentPush' | 'releasePush'): Promise<void>;
}
