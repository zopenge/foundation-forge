import type { ProcessIdentity } from '@openge/forge-process-control';

export interface ScopeClosureBudget {
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

export interface ScopeBackend {
  attach(pid: number): Promise<void>;
  bind(identity: ProcessIdentity): Promise<void>;
  empty(rootExited: boolean, budget: ScopeClosureBudget): Promise<boolean>;
  force(): Promise<void>;
  dispose(): Promise<void>;
}
