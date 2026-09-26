export type Truth = 'true' | 'false' | 'unknown';
export type PathRole = 'read' | 'write' | 'impact';
export type FactBasis = 'verified' | 'suggested' | 'unknown';

export interface SourceRef {
  readonly path: string;
}

export interface PathEvidence {
  readonly path: string;
  readonly role: PathRole;
}

export interface EvidenceRef {
  readonly id: string;
  readonly contextId: string;
  readonly sourceId: string;
  readonly digest: string;
}

export interface FactAssertion {
  readonly id: string;
  readonly state: Truth;
  readonly basis: FactBasis;
  readonly contextId: string;
  readonly evidenceIds: readonly string[];
}

export interface PathSelector {
  readonly prefixes?: readonly string[];
  readonly extensions?: readonly string[];
  readonly roles?: readonly PathRole[];
}

export interface FactPredicate {
  readonly id: string;
  readonly equals: boolean;
}

export interface PolicyClause {
  readonly path?: PathSelector;
  readonly facts?: readonly FactPredicate[];
}

export type PolicyCondition =
  | { readonly always: true }
  | { readonly anyOf: readonly PolicyClause[] };

export interface PolicyDefinition {
  readonly id: string;
  readonly source: SourceRef;
  readonly when: PolicyCondition;
  readonly requires: readonly string[];
  readonly conflictsWith: readonly string[];
  readonly checkIds: readonly string[];
}

export type CheckReference =
  | { readonly id: string; readonly kind: 'document'; readonly source: SourceRef }
  | {
      readonly id: string;
      readonly kind: 'package-script';
      readonly packageJson: string;
      readonly script: string;
    };

export interface PolicyManifest {
  readonly schemaVersion: 1;
  readonly factIds: readonly string[];
  readonly policies: readonly PolicyDefinition[];
  readonly checks: readonly CheckReference[];
}

export interface ResolveRequest {
  readonly schemaVersion: 1;
  readonly contextId: string;
  readonly scope: {
    readonly paths: readonly PathEvidence[];
    readonly complete: boolean;
  };
  readonly facts: readonly FactAssertion[];
  readonly evidence: readonly EvidenceRef[];
}

export interface PolicyDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly policyIds: readonly string[];
  readonly fieldPath: string;
  readonly relatedIds: readonly string[];
}

export interface ReasonEdge {
  readonly policyId: string;
  readonly kind: 'always' | 'path' | 'fact' | 'requires' | 'unknown';
  readonly fromId: string | null;
  readonly evidenceIds: readonly string[];
}

export interface PolicyResolution {
  readonly schemaVersion: 1;
  readonly state: 'ready' | 'needs-context' | 'invalid' | 'conflict';
  readonly contextId: string;
  readonly requiredIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly excludedIds: readonly string[];
  readonly unresolvedFactIds: readonly string[];
  readonly unresolvedScope: boolean;
  readonly reasons: readonly ReasonEdge[];
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export type ValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly diagnostics: readonly PolicyDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly PolicyDiagnostic[];
    };
