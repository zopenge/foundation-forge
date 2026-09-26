import type {
  PolicyDiagnostic,
  PolicyResolution,
  ResolveRequest,
  SourceRef,
} from '../contracts.js';

export interface NodePolicyReadLimits {
  readonly manifestBytes?: number;
  readonly requestBytes?: number;
  readonly sourceBytes?: number;
  readonly totalSourceBytes?: number;
}

export interface NodePolicyCheckOptions {
  readonly root: string;
  readonly manifestPath: string;
  readonly limits?: NodePolicyReadLimits;
}

export interface NodePolicyOptions extends NodePolicyCheckOptions {
  readonly request: ResolveRequest;
}

export interface PreparePolicyRepositoryOptions
  extends NodePolicyCheckOptions {
  readonly preload?: 'none' | 'policy-sources';
}

export interface PreparedPolicyRepository {
  readonly root: string;
  readonly manifestPath: string;
  resolve(request: ResolveRequest): Promise<PolicyBundle>;
}

export type PreparePolicyRepositoryResult =
  | {
      readonly ok: true;
      readonly repository: PreparedPolicyRepository;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly PolicyDiagnostic[];
    };

export interface PolicyCheckReport {
  readonly state: 'passed' | 'failed' | 'incomplete';
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export interface PolicyDocument {
  readonly source: SourceRef;
  readonly policyIds: readonly string[];
  readonly sha256: string;
  readonly utf8Bytes: number;
  readonly text: string | null;
}

export interface PolicyBundle {
  readonly resolution: PolicyResolution;
  readonly documents: readonly PolicyDocument[];
  readonly bundleDigest: string | null;
  readonly deliveryComplete: boolean;
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export interface ResolvedNodePolicyReadLimits {
  readonly manifestBytes: number;
  readonly requestBytes: number;
  readonly sourceBytes: number;
  readonly totalSourceBytes: number;
}

export const defaultNodePolicyReadLimits: ResolvedNodePolicyReadLimits = {
  manifestBytes: 1024 * 1024,
  requestBytes: 1024 * 1024,
  sourceBytes: 1024 * 1024,
  totalSourceBytes: 8 * 1024 * 1024,
};

export const resolveNodePolicyReadLimits = (
  limits: NodePolicyReadLimits | undefined,
): ResolvedNodePolicyReadLimits | null => {
  const resolved: ResolvedNodePolicyReadLimits = {
    manifestBytes: limits?.manifestBytes ?? defaultNodePolicyReadLimits.manifestBytes,
    requestBytes: limits?.requestBytes ?? defaultNodePolicyReadLimits.requestBytes,
    sourceBytes: limits?.sourceBytes ?? defaultNodePolicyReadLimits.sourceBytes,
    totalSourceBytes: limits?.totalSourceBytes ?? defaultNodePolicyReadLimits.totalSourceBytes,
  };
  return Object.values(resolved).every((value) => (
    Number.isSafeInteger(value) && value > 0
  ))
    ? resolved
    : null;
};
