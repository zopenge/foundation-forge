import { validatePortableRelativePath } from '@openge/forge-path-safety';

import type {
  PolicyDiagnostic,
  PolicyManifest,
  ValidationResult,
} from './contracts.js';

const MAX_POLICIES = 512;
const MAX_FACTS = 256;
const MAX_CHECKS = 512;
const MAX_RELATIONS = 8192;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ROLES = new Set(['read', 'write', 'impact']);

type RecordValue = Record<string, unknown>;

interface ParsedPolicy {
  readonly id: string | null;
  readonly requires: readonly string[];
  readonly conflicts: readonly string[];
  readonly checkIds: readonly string[];
  readonly relationCount: number;
}
const diagnostic = (
  code: string,
  fieldPath: string,
  policyIds: readonly string[] = [],
  relatedIds: readonly string[] = [],
): PolicyDiagnostic => ({
  code,
  severity: 'error',
  policyIds,
  fieldPath,
  relatedIds,
});

const isRecord = (value: unknown): value is RecordValue => (
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
);

const isId = (value: unknown): value is string => (
  typeof value === 'string' && ID_PATTERN.test(value)
);
const checkKeys = (
  value: RecordValue,
  allowed: readonly string[],
  fieldPath: string,
  diagnostics: PolicyDiagnostic[],
): void => {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      diagnostics.push(diagnostic(
        'UNKNOWN_FIELD',
        fieldPath ? `${fieldPath}.${key}` : key,
      ));
    }
  }
};

const hasWildcardSyntax = (value: string): boolean => (
  ['*', '?', '[', ']', '{', '}'].some((character) => value.includes(character))
);

const isLiteralPath = (value: unknown): value is string => {
  if (typeof value !== 'string' || hasWildcardSyntax(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
  try {
    validatePortableRelativePath(value);
    return true;
  } catch {
    return false;
  }
};

const isPrefix = (value: unknown): value is string => {
  if (value === '.') return true;
  if (typeof value !== 'string' || hasWildcardSyntax(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
  const candidate = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!candidate) return false;
  try {
    validatePortableRelativePath(candidate);
    return true;
  } catch {
    return false;
  }
};
const readIds = (
  value: unknown,
  fieldPath: string,
  diagnostics: PolicyDiagnostic[],
  duplicateCode = 'DUPLICATE_RELATION',
): readonly string[] => {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isId(item)) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}[${index}]`));
      return;
    }
    ids.push(item);
    if (seen.has(item)) {
      diagnostics.push(diagnostic(duplicateCode, `${fieldPath}[${index}]`, [], [item]));
    }
    seen.add(item);
  });
  return ids;
};
const validateSource = (
  value: unknown,
  fieldPath: string,
  diagnostics: PolicyDiagnostic[],
): void => {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return;
  }
  checkKeys(value, ['path'], fieldPath, diagnostics);
  if (!isLiteralPath(value.path)) {
    diagnostics.push(diagnostic('INVALID_PATH', `${fieldPath}.path`));
  }
};

const validateNonEmptyArray = (
  value: unknown,
  fieldPath: string,
  diagnostics: PolicyDiagnostic[],
): value is readonly unknown[] => {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return false;
  }
  return true;
};
const validatePathSelector = (
  value: unknown,
  fieldPath: string,
  diagnostics: PolicyDiagnostic[],
): number => {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return 0;
  }
  checkKeys(value, ['prefixes', 'extensions', 'roles'], fieldPath, diagnostics);
  const keys = ['prefixes', 'extensions', 'roles'].filter((key) => Object.hasOwn(value, key));
  if (keys.length === 0) {
    diagnostics.push(diagnostic('EMPTY_CLAUSE', fieldPath));
    return 0;
  }
  let relations = 0;
  if (Object.hasOwn(value, 'prefixes')) {
    if (validateNonEmptyArray(value.prefixes, `${fieldPath}.prefixes`, diagnostics)) {
      relations += value.prefixes.length;
      value.prefixes.forEach((prefix, index) => {
        if (!isPrefix(prefix)) {
          diagnostics.push(diagnostic('INVALID_PATH', `${fieldPath}.prefixes[${index}]`));
        }
      });
    }
  }
  if (Object.hasOwn(value, 'extensions')) {
    if (validateNonEmptyArray(value.extensions, `${fieldPath}.extensions`, diagnostics)) {
      relations += value.extensions.length;
      value.extensions.forEach((extension, index) => {
        const valid = typeof extension === 'string'
          && extension.length > 1
          && extension.length <= 32
          && extension.startsWith('.')
          && !extension.includes('/')
          && !extension.includes('\\');
        if (!valid) {
          diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.extensions[${index}]`));
        }
      });
    }
  }
  if (Object.hasOwn(value, 'roles')) {
    if (validateNonEmptyArray(value.roles, `${fieldPath}.roles`, diagnostics)) {
      relations += value.roles.length;
      value.roles.forEach((role, index) => {
        if (typeof role !== 'string' || !ROLES.has(role)) {
          diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.roles[${index}]`));
        }
      });
    }
  }
  return relations;
};

const validateFactPredicates = (
  value: unknown,
  fieldPath: string,
  declaredFacts: ReadonlySet<string>,
  diagnostics: PolicyDiagnostic[],
): number => {
  if (!validateNonEmptyArray(value, fieldPath, diagnostics)) return 0;
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const predicatePath = `${fieldPath}[${index}]`;
    if (!isRecord(item)) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', predicatePath));
      return;
    }
    checkKeys(item, ['id', 'equals'], predicatePath, diagnostics);
    if (!isId(item.id)) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `${predicatePath}.id`));
    } else {
      if (!declaredFacts.has(item.id)) {
        diagnostics.push(diagnostic('UNDECLARED_FACT', `${predicatePath}.id`, [], [item.id]));
      }
      if (seen.has(item.id)) {
        diagnostics.push(diagnostic('DUPLICATE_RELATION', `${predicatePath}.id`, [], [item.id]));
      }
      seen.add(item.id);
    }
    if (typeof item.equals !== 'boolean') {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `${predicatePath}.equals`));
    }
  });
  return value.length;
};

const validateCondition = (
  value: unknown,
  fieldPath: string,
  declaredFacts: ReadonlySet<string>,
  diagnostics: PolicyDiagnostic[],
): number => {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return 0;
  }
  const hasAlways = Object.hasOwn(value, 'always');
  const hasAnyOf = Object.hasOwn(value, 'anyOf');
  if (hasAlways === hasAnyOf) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return 0;
  }
  if (hasAlways) {
    checkKeys(value, ['always'], fieldPath, diagnostics);
    if (value.always !== true) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.always`));
    }
    return 0;
  }
  checkKeys(value, ['anyOf'], fieldPath, diagnostics);
  if (!validateNonEmptyArray(value.anyOf, `${fieldPath}.anyOf`, diagnostics)) return 0;
  let relations = 0;
  value.anyOf.forEach((clause, index) => {
    const clausePath = `${fieldPath}.anyOf[${index}]`;
    if (!isRecord(clause)) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', clausePath));
      return;
    }
    checkKeys(clause, ['path', 'facts'], clausePath, diagnostics);
    const hasPath = Object.hasOwn(clause, 'path');
    const hasFacts = Object.hasOwn(clause, 'facts');
    if (!hasPath && !hasFacts) {
      diagnostics.push(diagnostic('EMPTY_CLAUSE', clausePath));
      return;
    }
    if (hasPath) {
      relations += validatePathSelector(clause.path, `${clausePath}.path`, diagnostics);
    }
    if (hasFacts) {
      relations += validateFactPredicates(
        clause.facts,
        `${clausePath}.facts`,
        declaredFacts,
        diagnostics,
      );
    }
  });
  return relations;
};
const validatePolicy = (
  value: unknown,
  index: number,
  declaredFacts: ReadonlySet<string>,
  diagnostics: PolicyDiagnostic[],
): ParsedPolicy | null => {
  const fieldPath = `policies[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return null;
  }
  checkKeys(
    value,
    ['id', 'source', 'when', 'requires', 'conflictsWith', 'checkIds'],
    fieldPath,
    diagnostics,
  );
  const id = isId(value.id) ? value.id : null;
  if (id === null) diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.id`));
  validateSource(value.source, `${fieldPath}.source`, diagnostics);
  const conditionRelations = validateCondition(
    value.when,
    `${fieldPath}.when`,
    declaredFacts,
    diagnostics,
  );
  const requires = readIds(value.requires, `${fieldPath}.requires`, diagnostics);
  const conflicts = readIds(value.conflictsWith, `${fieldPath}.conflictsWith`, diagnostics);
  const checkIds = readIds(value.checkIds, `${fieldPath}.checkIds`, diagnostics);
  return {
    id,
    requires,
    conflicts,
    checkIds,
    relationCount: conditionRelations + requires.length + conflicts.length + checkIds.length,
  };
};

const validateCheck = (
  value: unknown,
  index: number,
  diagnostics: PolicyDiagnostic[],
): string | null => {
  const fieldPath = `checks[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', fieldPath));
    return null;
  }
  if (value.kind === 'document') {
    checkKeys(value, ['id', 'kind', 'source'], fieldPath, diagnostics);
    validateSource(value.source, `${fieldPath}.source`, diagnostics);
  } else if (value.kind === 'package-script') {
    checkKeys(value, ['id', 'kind', 'packageJson', 'script'], fieldPath, diagnostics);
    if (!isLiteralPath(value.packageJson)) {
      diagnostics.push(diagnostic('INVALID_PATH', `${fieldPath}.packageJson`));
    }
    if (
      typeof value.script !== 'string'
      || value.script.length === 0
      || value.script.length > 128
    ) {
      diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.script`));
    }
  } else {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.kind`));
  }
  if (!isId(value.id)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', `${fieldPath}.id`));
    return null;
  }
  return value.id;
};
const detectCycle = (
  policies: readonly ParsedPolicy[],
  policyIds: ReadonlySet<string>,
  diagnostics: PolicyDiagnostic[],
): void => {
  const graph = new Map<string, readonly string[]>();
  policies.forEach((policy) => {
    if (policy.id !== null) {
      graph.set(policy.id, policy.requires.filter((id) => policyIds.has(id)));
    }
  });
  const states = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const state = states.get(id) ?? 0;
    if (state === 1) return true;
    if (state === 2) return false;
    states.set(id, 1);
    for (const dependency of graph.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    states.set(id, 2);
    return false;
  };
  for (const id of graph.keys()) {
    if (visit(id)) {
      diagnostics.push(diagnostic('DEPENDENCY_CYCLE', 'policies', [id]));
      return;
    }
  }
};

const validateRelations = (
  policies: readonly ParsedPolicy[],
  policyIds: ReadonlySet<string>,
  checkIds: ReadonlySet<string>,
  diagnostics: PolicyDiagnostic[],
): void => {
  const conflictPairs = new Set<string>();
  policies.forEach((policy) => {
    const policyId = policy.id;
    if (policyId === null) return;
    policy.requires.forEach((requiredId) => {
      if (!policyIds.has(requiredId)) {
        diagnostics.push(diagnostic(
          'MISSING_REQUIREMENT',
          `policies.${policyId}.requires`,
          [policyId],
          [requiredId],
        ));
      }
    });
    policy.checkIds.forEach((checkId) => {
      if (!checkIds.has(checkId)) {
        diagnostics.push(diagnostic(
          'CHECK_TARGET_MISSING',
          `policies.${policyId}.checkIds`,
          [policyId],
          [checkId],
        ));
      }
    });
    policy.conflicts.forEach((conflictId) => {
      if (!policyIds.has(conflictId) || conflictId === policyId) {
        diagnostics.push(diagnostic(
          'INVALID_RELATION',
          `policies.${policyId}.conflictsWith`,
          [policyId],
          [conflictId],
        ));
        return;
      }
      const pair = [policyId, conflictId].sort().join('|');
      if (conflictPairs.has(pair)) {
        diagnostics.push(diagnostic(
          'DUPLICATE_RELATION',
          `policies.${policyId}.conflictsWith`,
          [policyId],
          [conflictId],
        ));
      }
      conflictPairs.add(pair);
    });
  });
};

const hasManifestShape = (
  value: RecordValue,
): value is RecordValue & PolicyManifest => (
  value.schemaVersion === 1
  && Array.isArray(value.factIds)
  && Array.isArray(value.policies)
  && Array.isArray(value.checks)
);

export const validatePolicyManifest = (
  input: unknown,
): ValidationResult<PolicyManifest> => {
  const diagnostics: PolicyDiagnostic[] = [];
  if (!isRecord(input)) {
    return { ok: false, diagnostics: [diagnostic('INVALID_SCHEMA', '')] };
  }
  checkKeys(input, ['schemaVersion', 'factIds', 'policies', 'checks'], '', diagnostics);
  if (input.schemaVersion !== 1) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'schemaVersion'));
  }

  const factIds = readIds(input.factIds, 'factIds', diagnostics, 'DUPLICATE_ID');
  if (factIds.length > MAX_FACTS) {
    diagnostics.push(diagnostic('INPUT_LIMIT', 'factIds'));
  }
  const declaredFacts = new Set(factIds);

  const checks = Array.isArray(input.checks) ? input.checks : [];
  if (!Array.isArray(input.checks)) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'checks'));
  }
  if (checks.length > MAX_CHECKS) {
    diagnostics.push(diagnostic('INPUT_LIMIT', 'checks'));
  }
  const checkIds = new Set<string>();
  checks.forEach((check, index) => {
    const id = validateCheck(check, index, diagnostics);
    if (id === null) return;
    if (checkIds.has(id)) {
      diagnostics.push(diagnostic('DUPLICATE_ID', `checks[${index}].id`, [], [id]));
    }
    checkIds.add(id);
  });

  const policies = Array.isArray(input.policies) ? input.policies : [];
  if (!Array.isArray(input.policies) || policies.length === 0) {
    diagnostics.push(diagnostic('INVALID_SCHEMA', 'policies'));
  }
  if (policies.length > MAX_POLICIES) {
    diagnostics.push(diagnostic('INPUT_LIMIT', 'policies'));
  }
  const parsedPolicies = policies
    .map((policy, index) => validatePolicy(
      policy,
      index,
      declaredFacts,
      diagnostics,
    ))
    .filter((policy): policy is ParsedPolicy => policy !== null);
  const policyIds = new Set<string>();
  parsedPolicies.forEach((policy, index) => {
    if (policy.id === null) return;
    if (policyIds.has(policy.id)) {
      diagnostics.push(diagnostic(
        'DUPLICATE_ID',
        `policies[${index}].id`,
        [policy.id],
      ));
    }
    policyIds.add(policy.id);
  });

  const relationCount = parsedPolicies.reduce(
    (total, policy) => total + policy.relationCount,
    0,
  );
  if (relationCount > MAX_RELATIONS) {
    diagnostics.push(diagnostic('INPUT_LIMIT', 'policies'));
  }

  validateRelations(parsedPolicies, policyIds, checkIds, diagnostics);
  detectCycle(parsedPolicies, policyIds, diagnostics);

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (!hasManifestShape(input)) {
    return { ok: false, diagnostics: [diagnostic('INVALID_SCHEMA', '')] };
  }
  return {
    ok: true,
    value: input,
    diagnostics: [],
  };
};
