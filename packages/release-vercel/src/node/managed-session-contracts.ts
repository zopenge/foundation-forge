import type { ReleaseBudget, ReleaseReport } from '../contracts.js';
import type { Execution } from './execution.js';
import type { ManagedState } from './managed-state-contracts.js';
import type { ManagedSlot } from './managed-slot-contracts.js';

export interface ManagedSession {
  readonly slot: ManagedSlot;
  readonly command: 'check' | 'publish' | 'verify';
  readonly state: ManagedState;
  readonly budget: {
    sample(): Promise<void>;
    summary(): ReleaseBudget;
  };
  readonly execution: Execution;
  readonly steps: ReleaseReport['steps'];
  persist(): Promise<void>;
  assertClosed(): Promise<void>;
  assertStopped(): Promise<void>;
  executionAt(cwd: string): Execution;
}
