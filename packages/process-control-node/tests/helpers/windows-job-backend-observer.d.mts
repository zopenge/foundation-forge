import type { ScopeBackend } from '../../dist/owned-scope/backend.js';

export interface WindowsJobBackendFailure {
  method: string;
  rootExited?: boolean;
  remainingMs?: number;
  code?: string;
  stage?: string;
  nativeCode?: number;
}

export declare function wrapWindowsJobBackend(backend: ScopeBackend, failures: WindowsJobBackendFailure[], now?: () => number): ScopeBackend;
