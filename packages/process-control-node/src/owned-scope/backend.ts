import type { ProcessIdentity } from '@openge/forge-process-control';

export interface ScopeBackend {
  attach(pid: number): Promise<void>;
  bind(identity: ProcessIdentity): Promise<void>;
  empty(rootExited: boolean): Promise<boolean>;
  force(): Promise<void>;
  dispose(): Promise<void>;
}
