export type ReleaseCommand = 'check' | 'publish' | 'status' | 'verify' | 'recover' | 'login';
export interface ReleaseCheck {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}
export type ReleaseSource = { readonly mode: 'workspace' } | {
  readonly mode: 'managed-commit';
  readonly slotPath: string;
  readonly maxBytes: number;
  readonly minFreeBytes: number;
  readonly sampleIntervalMs: number;
  readonly install: { readonly packageManager: 'pnpm' };
  readonly prepare: readonly ReleaseCheck[];
};
export type ManagedSourceConfig = Extract<ReleaseSource, { mode: 'managed-commit' }>;
export type ReleaseStage = 'source' | 'admission' | 'checkout' | 'install' | 'prepare' | 'checks'
  | 'push-dev' | 'push-main' | 'deployment' | 'acceptance' | 'recover' | 'complete' | 'failed';
export interface ReleaseBudget {
  readonly sampleCount: number;
  readonly maxObservedBytes: number;
  readonly minObservedFreeBytes: number;
  readonly maxObservationGapMs: number;
  readonly observationsComplete: boolean;
}
export interface ReleaseConfig {
  readonly schemaVersion: 2;
  readonly source: ReleaseSource;
  readonly git: { readonly remote: string; readonly repository: string; readonly developmentBranch: string; readonly releaseBranch: string };
  readonly vercel: { readonly teamId: string; readonly projectId: string; readonly productionUrl: string };
  readonly checks: readonly ReleaseCheck[];
  readonly acceptance: readonly ReleaseCheck[];
  readonly buildInfo: { readonly path: string; readonly revisionField: string };
  readonly limits: { readonly commandMs: number; readonly deploymentMs: number; readonly pollMs: number; readonly requestMs: number; readonly maxOutputBytes: number };
}
export const releaseErrorCodes = [
  'ARGUMENT_INVALID', 'CONFIG_INVALID', 'CONFIG_READ', 'GIT_FAILED', 'GIT_DIRTY', 'GIT_BRANCH', 'GIT_REPOSITORY',
  'GIT_DIVERGED', 'CANDIDATE_CHANGED', 'CHECK_FAILED', 'ACCEPTANCE_FAILED', 'COMMAND_TIMEOUT', 'COMMAND_FAILED',
  'CANCELLED', 'LOCKED', 'LOCK_OWNERSHIP', 'AUTH_REQUIRED', 'VERCEL_API', 'DEPLOYMENT_SOURCE', 'DEPLOYMENT_FAILED',
  'DEPLOYMENT_TIMEOUT', 'DEPLOYMENT_MISSING', 'ALIAS_MISMATCH', 'BUILD_REVISION', 'BUILD_INFO', 'IO_FAILED',
  'SOURCE_UNSUPPORTED', 'SOURCE_CHANGED', 'SLOT_PATH', 'SLOT_FOREIGN', 'SLOT_STATE', 'SLOT_NOT_FAST_FORWARD',
  'BUDGET_EXCEEDED', 'BUDGET_UNKNOWN', 'PROCESS_STATE_UNKNOWN', 'RECOVERY_REQUIRED', 'RECEIPT_SHA_MISMATCH',
] as const;
export type ReleaseErrorCode = typeof releaseErrorCodes[number];
export interface ReleaseDiagnostic { readonly code: ReleaseErrorCode; readonly details: Readonly<Record<string, unknown>> }
export interface ReleaseDeployment { readonly id: string; readonly sha: string; readonly projectId: string; readonly state: string; readonly url: string }
export interface ReleaseStep {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly truncated?: boolean;
  readonly exitCode?: number | null;
}
export type ReleasePushEffect = 'not-attempted' | 'pushed' | 'already-current' | 'unknown' | 'not-current';
export type ReleaseRefRelation = 'candidate' | 'before' | 'after' | 'diverged' | 'unknown';
export interface ReleaseRecoveryObservation {
  readonly owner: 'inactive' | 'active' | 'unknown';
  readonly processes: 'closed' | 'running' | 'unknown';
  readonly observedAt: string;
  readonly developmentRef?: { readonly sha: string; readonly relation: ReleaseRefRelation };
  readonly releaseRef?: { readonly sha: string; readonly relation: ReleaseRefRelation };
}
export interface ReleaseReport {
  readonly schemaVersion: 2;
  readonly command: ReleaseCommand;
  readonly ok: boolean;
  readonly candidateSha?: string;
  readonly configSha256?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly ReleaseStep[];
  readonly effects: { developmentPush: ReleasePushEffect; releasePush: ReleasePushEffect };
  readonly deployment?: ReleaseDeployment;
  readonly error?: ReleaseDiagnostic;
  readonly recovery?: { readonly candidateSha: string; readonly nextCommand: string; readonly reportPath: string; readonly observation?: ReleaseRecoveryObservation };
  readonly runId?: string;
  readonly sourceRoot?: string;
  readonly executionRoot?: string;
  readonly slotId?: string;
  readonly configPath?: string;
  readonly stage?: ReleaseStage;
  readonly budget?: ReleaseBudget;
  readonly processes?: { readonly status: 'closed' | 'unknown' | 'running'; readonly knownCount: number };
}
export interface ReleaseTransport {
  api(path: string, signal: AbortSignal): Promise<unknown>;
  buildInfo(url: string, signal: AbortSignal): Promise<unknown>;
}
export interface RunReleaseOptions {
  readonly command: ReleaseCommand;
  readonly cwd: string;
  readonly config?: ReleaseConfig;
  readonly configPath?: string;
  readonly sha?: string;
  readonly signal?: AbortSignal;
  readonly transport?: ReleaseTransport;
  readonly onLoginOutput?: (text: string) => void;
}
