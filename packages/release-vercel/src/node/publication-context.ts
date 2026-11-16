import type { PrebuiltReleaseState, ReleaseConfig, ReleaseReport, ReleaseStage, ReleaseTransport } from '../contracts.js';
import type { Execution } from './execution.js';

export interface ExecutionContext {
  readonly execution: Execution; readonly config: ReleaseConfig; readonly sha: string;
  readonly signal: AbortSignal | undefined; readonly transport: ReleaseTransport | undefined;
  readonly effects: ReleaseReport['effects'];
  readonly prebuilt?: {
    state: PrebuiltReleaseState | undefined;
    reserve(bytes: number): Promise<void>;
    executionAt(cwd: string): Execution;
    save(state: PrebuiltReleaseState): Promise<void>;
  } | undefined;
  assertFrozen(): Promise<void>;
  mutationGuard(effect?: 'developmentPush' | 'releasePush'): Promise<'already-current' | undefined>;
  stage(stage: ReleaseStage): Promise<void>;
  checkpoint(pending?: 'developmentPush' | 'releasePush'): Promise<void>;
}
