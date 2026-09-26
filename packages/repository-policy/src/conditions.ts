import type {
  FactPredicate,
  PathEvidence,
  PathSelector,
  PolicyClause,
  PolicyCondition,
  ResolveRequest,
  Truth,
} from './contracts.js';
import { validateResolveRequest } from './request.js';

export interface ConditionReason {
  readonly kind: 'always' | 'path' | 'fact' | 'unknown';
  readonly fromId: string | null;
  readonly evidenceIds: readonly string[];
}

export interface ConditionEvaluation {
  readonly truth: Truth;
  readonly unresolvedFactIds: readonly string[];
  readonly unresolvedScope: boolean;
  readonly reasons: readonly ConditionReason[];
}

const uniqueSorted = (values: readonly string[]): readonly string[] => (
  [...new Set(values)].sort()
);
const combineAndTruth = (values: readonly Truth[]): Truth => {
  if (values.includes('false')) return 'false';
  return values.every((value) => value === 'true') ? 'true' : 'unknown';
};

const combineOrTruth = (values: readonly Truth[]): Truth => {
  if (values.includes('true')) return 'true';
  return values.every((value) => value === 'false') ? 'false' : 'unknown';
};

const matchesPrefix = (path: string, rawPrefix: string): boolean => {
  if (rawPrefix === '.') return true;
  const prefix = rawPrefix.endsWith('/') ? rawPrefix.slice(0, -1) : rawPrefix;
  return path === prefix || path.startsWith(`${prefix}/`);
};

const pathEvidenceMatches = (
  selector: PathSelector,
  evidence: PathEvidence,
): boolean => {
  const prefixMatch = selector.prefixes === undefined
    || selector.prefixes.some((prefix) => matchesPrefix(evidence.path, prefix));
  const extensionMatch = selector.extensions === undefined
    || selector.extensions.some((extension) => evidence.path.endsWith(extension));
  const roleMatch = selector.roles === undefined
    || selector.roles.includes(evidence.role);
  return prefixMatch && extensionMatch && roleMatch;
};
const evaluatePathSelector = (
  selector: PathSelector,
  request: ResolveRequest,
): ConditionEvaluation => {
  const match = request.scope.paths.find((evidence) => pathEvidenceMatches(selector, evidence));
  if (match !== undefined) {
    return {
      truth: 'true',
      unresolvedFactIds: [],
      unresolvedScope: false,
      reasons: [{
        kind: 'path',
        fromId: match.path,
        evidenceIds: [],
      }],
    };
  }
  if (request.scope.complete) {
    return {
      truth: 'false',
      unresolvedFactIds: [],
      unresolvedScope: false,
      reasons: [{
        kind: 'path',
        fromId: null,
        evidenceIds: [],
      }],
    };
  }
  return {
    truth: 'unknown',
    unresolvedFactIds: [],
    unresolvedScope: true,
    reasons: [{
      kind: 'unknown',
      fromId: null,
      evidenceIds: [],
    }],
  };
};
const evaluateFactPredicate = (
  predicate: FactPredicate,
  request: ResolveRequest,
): ConditionEvaluation => {
  const fact = request.facts.find((candidate) => candidate.id === predicate.id);
  if (
    fact === undefined
    || fact.basis !== 'verified'
    || fact.contextId !== request.contextId
    || fact.state === 'unknown'
  ) {
    return {
      truth: 'unknown',
      unresolvedFactIds: [predicate.id],
      unresolvedScope: false,
      reasons: [{
        kind: 'unknown',
        fromId: predicate.id,
        evidenceIds: fact?.evidenceIds ?? [],
      }],
    };
  }
  const actual = fact.state === 'true';
  return {
    truth: actual === predicate.equals ? 'true' : 'false',
    unresolvedFactIds: [],
    unresolvedScope: false,
    reasons: [{
      kind: 'fact',
      fromId: predicate.id,
      evidenceIds: fact.evidenceIds,
    }],
  };
};
const combineAnd = (
  evaluations: readonly ConditionEvaluation[],
): ConditionEvaluation => {
  // 单项组合不改变私有叶节点的结果，避免再次复制解释与未知事实数组。
  const single = evaluations.length === 1 ? evaluations[0] : undefined;
  if (single !== undefined) return single;
  const truth = combineAndTruth(evaluations.map((evaluation) => evaluation.truth));
  const relevant = truth === 'false'
    ? evaluations.filter((evaluation) => evaluation.truth === 'false')
    : evaluations;
  return {
    truth,
    unresolvedFactIds: truth === 'unknown'
      ? uniqueSorted(relevant.flatMap((evaluation) => evaluation.unresolvedFactIds))
      : [],
    unresolvedScope: truth === 'unknown'
      && relevant.some((evaluation) => evaluation.unresolvedScope),
    reasons: relevant.flatMap((evaluation) => evaluation.reasons),
  };
};

const combineOr = (
  evaluations: readonly ConditionEvaluation[],
): ConditionEvaluation => {
  const single = evaluations.length === 1 ? evaluations[0] : undefined;
  if (single !== undefined) return single;
  const truth = combineOrTruth(evaluations.map((evaluation) => evaluation.truth));
  const relevant = truth === 'true'
    ? evaluations.filter((evaluation) => evaluation.truth === 'true')
    : truth === 'unknown'
      ? evaluations.filter((evaluation) => evaluation.truth === 'unknown')
      : evaluations;
  return {
    truth,
    unresolvedFactIds: truth === 'unknown'
      ? uniqueSorted(relevant.flatMap((evaluation) => evaluation.unresolvedFactIds))
      : [],
    unresolvedScope: truth === 'unknown'
      && relevant.some((evaluation) => evaluation.unresolvedScope),
    reasons: relevant.flatMap((evaluation) => evaluation.reasons),
  };
};
const evaluateClause = (
  clause: PolicyClause,
  request: ResolveRequest,
): ConditionEvaluation => {
  const evaluations: ConditionEvaluation[] = [];
  if (clause.path !== undefined) {
    evaluations.push(evaluatePathSelector(clause.path, request));
  }
  if (clause.facts !== undefined) {
    evaluations.push(combineAnd(
      clause.facts.map((predicate) => evaluateFactPredicate(predicate, request)),
    ));
  }
  return combineAnd(evaluations);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const assertCondition: (
  condition: unknown,
) => asserts condition is PolicyCondition = (condition) => {
  if (!isRecord(condition)) throw new TypeError('Invalid policy condition');
  const keys = Object.keys(condition);
  if ('always' in condition) {
    if (condition.always !== true || keys.length !== 1) {
      throw new TypeError('Invalid policy condition');
    }
    return;
  }
  if (
    !Array.isArray(condition.anyOf)
    || condition.anyOf.length === 0
    || keys.length !== 1
  ) {
    throw new TypeError('Invalid policy condition');
  }
  for (const clause of condition.anyOf) {
    if (!isRecord(clause)) throw new TypeError('Invalid policy clause');
    const clauseKeys = Object.keys(clause);
    if (
      clauseKeys.length === 0
      || clauseKeys.some((key) => key !== 'path' && key !== 'facts')
    ) {
      throw new TypeError('Invalid policy clause');
    }
    if ('path' in clause) {
      if (!isRecord(clause.path)) throw new TypeError('Invalid path selector');
      const selectorKeys = Object.keys(clause.path);
      if (
        selectorKeys.length === 0
        || selectorKeys.some((key) => !['prefixes', 'extensions', 'roles'].includes(key))
      ) {
        throw new TypeError('Invalid path selector');
      }
      for (const key of selectorKeys) {
        const value = clause.path[key];
        if (!Array.isArray(value) || value.length === 0) {
          throw new TypeError('Invalid path selector');
        }
      }
    }
    if ('facts' in clause) {
      if (!Array.isArray(clause.facts) || clause.facts.length === 0) {
        throw new TypeError('Invalid fact predicates');
      }
      for (const predicate of clause.facts) {
        if (
          !isRecord(predicate)
          || Object.keys(predicate).length !== 2
          || typeof predicate.id !== 'string'
          || typeof predicate.equals !== 'boolean'
        ) {
          throw new TypeError('Invalid fact predicate');
        }
      }
    }
  }
};

// 仅供已经校验 manifest 和 request 的内部解析路径使用。
export const evaluateValidatedPolicyConditionDetails = (
  condition: PolicyCondition,
  request: ResolveRequest,
): ConditionEvaluation => {
  if ('always' in condition) {
    return {
      truth: 'true',
      unresolvedFactIds: [],
      unresolvedScope: false,
      reasons: [{
        kind: 'always',
        fromId: null,
        evidenceIds: [],
      }],
    };
  }
  return combineOr(
    condition.anyOf.map((clause) => evaluateClause(clause, request)),
  );
};
export const evaluatePolicyConditionDetails = (
  condition: PolicyCondition,
  request: ResolveRequest,
): ConditionEvaluation => {
  assertCondition(condition);
  const requestValidation = validateResolveRequest(request);
  if (!requestValidation.ok) {
    throw new TypeError('Invalid resolve request');
  }
  return evaluateValidatedPolicyConditionDetails(condition, requestValidation.value);
};
export const evaluatePolicyCondition = (
  condition: PolicyCondition,
  request: ResolveRequest,
): Truth => (
  evaluatePolicyConditionDetails(condition, request).truth
);
