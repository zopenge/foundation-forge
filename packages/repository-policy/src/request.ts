import { validatePortableRelativePath } from '@openge/forge-path-safety';

import type {
  PolicyDiagnostic,
  ResolveRequest,
  ValidationResult,
} from './contracts.js';

const MAX_PATHS = 512;
const MAX_FACTS = 256;
const MAX_EVIDENCE = 512;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ROLES = new Set(['read', 'write', 'impact']);
const TRUTHS = new Set(['true', 'false', 'unknown']);
const BASES = new Set(['verified', 'suggested', 'unknown']);

type RecordValue = Record<string, unknown>;

const diagnostic = (code: string, fieldPath: string, relatedIds: readonly string[] = []): PolicyDiagnostic => ({
  code,
  severity: 'error',
  policyIds: [],
  fieldPath,
  relatedIds,
});
const isRecord = (value: unknown): value is RecordValue => (
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
);

const checkKeys = (
  value: RecordValue,
  allowed: readonly string[],
  fieldPath: string,
  diagnostics: PolicyDiagnostic[],
): void => {
  const known = new Set(allowed);
  Object.keys(value).forEach((key) => {
    if (!known.has(key)) {
      diagnostics.push(diagnostic(
        'UNKNOWN_FIELD',
        fieldPath ? `${fieldPath}.${key}` : key,
      ));
    }
  });
};

const isId = (value: unknown): value is string => (
  typeof value === 'string' && ID_PATTERN.test(value)
);
const isContextId = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= 256
);

const isPath = (value: unknown): value is string => {
  if (value === '.') return true;
  if (typeof value !== 'string') return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
  try {
    validatePortableRelativePath(value);
    return true;
  } catch {
    return false;
  }
};

const hasResolveRequestShape = (
  value: RecordValue,
): value is RecordValue & ResolveRequest => (
  value.schemaVersion === 1
  && isContextId(value.contextId)
  && isRecord(value.scope)
  && Array.isArray(value.facts)
  && Array.isArray(value.evidence)
);
const validateScope = (
  value: unknown,
  diagnostics: PolicyDiagnostic[],
): void => {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'scope'));
    return;
  }
  checkKeys(value, ['paths', 'complete'], 'scope', diagnostics);
  if (typeof value.complete !== 'boolean') {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'scope.complete'));
  }
  if (!Array.isArray(value.paths)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'scope.paths'));
    return;
  }
  if (value.paths.length > MAX_PATHS) {
    diagnostics.push(diagnostic('INPUT_LIMIT', 'scope.paths'));
  }
  value.paths.forEach((pathValue, index) => {
    const fieldPath = `scope.paths[${index}]`;
    if (!isRecord(pathValue)) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
      return;
    }
    checkKeys(pathValue, ['path', 'role'], fieldPath, diagnostics);
    if (!isPath(pathValue.path)) {
      diagnostics.push(diagnostic('INVALID_PATH', `${fieldPath}.path`));
    }
    if (typeof pathValue.role !== 'string' || !ROLES.has(pathValue.role)) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.role`));
    }
  });
};
const validateEvidence = (
  value: unknown,
  index: number,
  diagnostics: PolicyDiagnostic[],
): string | null => {
  const fieldPath = `evidence[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return null;
  }
  checkKeys(value, ['id', 'contextId', 'sourceId', 'digest'], fieldPath, diagnostics);
  if (!isId(value.id)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.id`));
    return null;
  }
  if (!isContextId(value.contextId)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.contextId`));
  }
  if (!isId(value.sourceId)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.sourceId`));
  }
  if (
    typeof value.digest !== 'string'
    || value.digest.length === 0
    || value.digest.length > 512
  ) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.digest`));
  }
  return value.id;
};
interface FactValidation {
  readonly id: string | null;
  readonly basis: string | null;
  readonly state: string | null;
  readonly contextId: string | null;
  readonly evidenceIds: readonly string[];
}

const validateFact = (
  value: unknown,
  index: number,
  diagnostics: PolicyDiagnostic[],
): FactValidation | null => {
  const fieldPath = `facts[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return null;
  }
  checkKeys(value, ['id', 'state', 'basis', 'contextId', 'evidenceIds'], fieldPath, diagnostics);
  const id = isId(value.id) ? value.id : null;
  if (id === null) diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.id`));
  const state = typeof value.state === 'string' && TRUTHS.has(value.state) ? value.state : null;
  if (state === null) diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.state`));
  const basis = typeof value.basis === 'string' && BASES.has(value.basis) ? value.basis : null;
  if (basis === null) diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.basis`));
  const contextId = isContextId(value.contextId) ? value.contextId : null;
  if (contextId === null) diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.contextId`));
  const evidenceIds: string[] = [];
  if (!Array.isArray(value.evidenceIds)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.evidenceIds`));
  } else {
    const seen = new Set<string>();
    value.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!isId(evidenceId)) {
        diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.evidenceIds[${evidenceIndex}]`));
        return;
      }
      evidenceIds.push(evidenceId);
      if (seen.has(evidenceId)) {
        diagnostics.push(diagnostic('DUPLICATE_ID', `${fieldPath}.evidenceIds[${evidenceIndex}]`, [evidenceId]));
      }
      seen.add(evidenceId);
    });
  }
  if (basis === 'verified') {
    if (state === 'unknown') diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.state`));
    if (evidenceIds.length === 0) diagnostics.push(diagnostic('MISSING_EVIDENCE', `${fieldPath}.evidenceIds`));
  }
  if (basis === 'unknown' && state !== 'unknown') {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.state`));
  }
  return { id, basis, state, contextId, evidenceIds };
};
export const validateResolveRequest = (
  input: unknown,
): ValidationResult<ResolveRequest> => {
  const diagnostics: PolicyDiagnostic[] = [];
  if (!isRecord(input)) {
    return { ok: false, diagnostics: [diagnostic('INVALID_SCHEMA', '')] };
  }
  checkKeys(input, ['schemaVersion', 'contextId', 'scope', 'facts', 'evidence'], '', diagnostics);
  if (input.schemaVersion !== 1) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'schemaVersion'));
  }
  if (!isContextId(input.contextId)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'contextId'));
  }

  validateScope(input.scope, diagnostics);

  const evidenceValues = Array.isArray(input.evidence) ? input.evidence : [];
  if (!Array.isArray(input.evidence)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'evidence'));
  }
  if (evidenceValues.length > MAX_EVIDENCE) {
    diagnostics.push(diagnostic('INPUT_LIMIT', 'evidence'));
  }
  const evidenceById = new Map<string, { readonly contextId: string | null }>();
  evidenceValues.forEach((value, index) => {
    const id = validateEvidence(value, index, diagnostics);
    if (id === null) return;
    if (evidenceById.has(id)) {
      diagnostics.push(diagnostic('DUPLICATE_ID', `evidence[${index}].id`, [id]));
      return;
    }
    const contextId = isRecord(value) && isContextId(value.contextId)
      ? value.contextId
      : null;
    evidenceById.set(id, { contextId });
  });

  const factValues = Array.isArray(input.facts) ? input.facts : [];
  if (!Array.isArray(input.facts)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'facts'));
  }
  if (factValues.length > MAX_FACTS) {
    diagnostics.push(diagnostic('INPUT_LIMIT', 'facts'));
  }
  const factIds = new Set<string>();
  factValues.forEach((value, index) => {
    const fact = validateFact(value, index, diagnostics);
    if (fact === null || fact.id === null) return;
    if (factIds.has(fact.id)) {
      diagnostics.push(diagnostic('DUPLICATE_ID', `facts[${index}].id`, [fact.id]));
    }
    factIds.add(fact.id);
    if (fact.basis !== 'verified') return;
    fact.evidenceIds.forEach((evidenceId) => {
      const evidence = evidenceById.get(evidenceId);
      if (
        evidence === undefined
        || fact.contextId === null
        || evidence.contextId !== fact.contextId
      ) {
        diagnostics.push(diagnostic(
          'MISSING_EVIDENCE',
          `facts[${index}].evidenceIds`,
          [evidenceId],
        ));
      }
    });
  });

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (!hasResolveRequestShape(input)) {
    return { ok: false, diagnostics: [diagnostic('INVALID_SCHEMA', '')] };
  }
  return { ok: true, value: input, diagnostics: [] };
};
