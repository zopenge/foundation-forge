export type ReleaseCommand = 'check' | 'publish' | 'status' | 'verify' | 'login';
export interface ReleaseCheck {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}
export interface ReleaseConfig {
  readonly schemaVersion: 1;
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
export interface ReleaseReport {
  readonly schemaVersion: 1;
  readonly command: ReleaseCommand;
  readonly ok: boolean;
  readonly candidateSha?: string;
  readonly configSha256?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly steps: readonly ReleaseStep[];
  readonly effects: { developmentPush: 'not-attempted' | 'pushed' | 'already-current' | 'unknown'; releasePush: 'not-attempted' | 'pushed' | 'already-current' | 'unknown' };
  readonly deployment?: ReleaseDeployment;
  readonly error?: ReleaseDiagnostic;
  readonly recovery?: { readonly candidateSha: string; readonly nextCommand: string; readonly reportPath: string };
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
