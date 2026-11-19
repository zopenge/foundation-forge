import type { PrebuiltReleaseState, ReleaseCommand, ReleaseCompletionState, ReleaseConfig, ReleaseReport, ReleaseStage } from '../contracts.js';
import type { CommandTerminationReason } from '@openge/forge-command-runner';
import type { ProcessScopeClosure } from '@openge/forge-process-control';
import type { RetirementHost } from './retirement-host.js';

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
export interface CompletionInputBinding {
  readonly schemaVersion: 1;
  readonly checkout: FileIdentity; readonly git: FileIdentity; readonly output: FileIdentity; readonly upload: FileIdentity;
  readonly manifest: MetadataFile;
}
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
  notStarted?: { readonly schemaVersion: 1; readonly reason: 'cancelled-before-runner' | 'budget-before-runner'; readonly binding: string; readonly observedAt: string };
  terminalSha256?: string;
  closure?: { readonly observedAt: string; readonly exitCode: number | null; readonly termination: CommandTerminationReason; readonly requestedTermination?: 'abort' | 'timeout'; readonly ownedScope?: ProcessScopeClosure };
}
export interface PrebuiltEffectResolution {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sourceSha: string;
  readonly configSha256: string;
  readonly artifactSha256: string;
  readonly deploymentId: string;
  readonly promotion: 'not-attempted' | 'succeeded' | 'failed';
  readonly versionAlias?: { readonly hostname: string; readonly verified: true };
  readonly observedAt: string;
}
export interface ManagedState {
  readonly schemaVersion: 3; readonly slotId: string; readonly runId: string;
  readonly source: FrozenSource; readonly command: ReleaseCommand;
  checkoutIdentity?: FileIdentity;
  readonly coordinator: RecordedIdentity;
  readonly coordinatorLease?: 'native-directory';
  readonly host: RetirementHost;
  readonly history: readonly ManagedHistoryReference[];
  stage: ReleaseStage; status: 'running' | 'closed' | 'unknown';
  processes: ManagedCommand[];
  effects: ReleaseReport['effects'];
  pendingPush?: 'developmentPush' | 'releasePush';
  prebuilt?: PrebuiltReleaseState;
  completion?: ReleaseCompletionState;
  completionInput?: CompletionInputBinding;
  prebuiltResolutions?: readonly PrebuiltEffectResolution[];
}
export interface ManagedReceipt { readonly schemaVersion: 2; readonly slotId: string; readonly source: FrozenSource; readonly report: ReleaseReport }
export interface ManagedAnchor {
  readonly schemaVersion: 2; readonly slotId: string; readonly slotPath: string; readonly configPath: string;
  readonly sourceRoot: string;
  readonly latestPublish?: { readonly sha: string; readonly runId: string; readonly configSha256: string };
}
