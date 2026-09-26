import type {
  PolicyDefinition,
  PolicyDiagnostic,
  PolicyManifest,
  PolicyResolution,
  ReasonEdge,
  ResolveRequest,
  Truth,
} from './contracts.js';
import {
  evaluateValidatedPolicyConditionDetails,
  type ConditionEvaluation,
} from './conditions.js';
import { policyDiagnostic } from './diagnostics.js';
import { validatePolicyManifest } from './manifest.js';
import { stableTopologicalOrder } from './relations.js';
import { validateResolveRequest } from './request.js';

const invalidResolution = (
  contextId: string,
  diagnostics: readonly PolicyDiagnostic[],
): PolicyResolution => ({
  schemaVersion: 1,
  state: 'invalid',
  contextId,
  requiredIds: [],
  candidateIds: [],
  excludedIds: [],
  unresolvedFactIds: [],
  unresolvedScope: false,
  reasons: [],
  diagnostics,
});
const addClosure = (
  roots: ReadonlySet<string>,
  byId: ReadonlyMap<string, PolicyDefinition>,
): Set<string> => {
  const result = new Set<string>();
  const visit = (id: string): void => {
    if (result.has(id)) return;
    result.add(id);
    const definition = byId.get(id);
    if (definition === undefined) return;
    for (const dependency of definition.requires) {
      visit(dependency);
    }
  };
  [...roots].sort().forEach(visit);
  return result;
};

const collectRequiresReasons = (
  included: ReadonlySet<string>,
  byId: ReadonlyMap<string, PolicyDefinition>,
): readonly ReasonEdge[] => {
  const reasons: ReasonEdge[] = [];
  for (const id of [...included].sort()) {
    const definition = byId.get(id);
    if (definition === undefined) continue;
    for (const dependency of [...definition.requires].sort()) {
      if (!included.has(dependency)) continue;
      reasons.push({
        policyId: dependency,
        kind: 'requires',
        fromId: id,
        evidenceIds: [],
      });
    }
  }
  return reasons;
};
interface ConflictPair {
  readonly left: string;
  readonly right: string;
}

interface ResolutionIndex {
  readonly definitions: readonly PolicyDefinition[];
  readonly byId: ReadonlyMap<string, PolicyDefinition>;
  readonly requiresById: ReadonlyMap<string, readonly string[]>;
  readonly conflictPairs: readonly ConflictPair[];
}

const buildResolutionIndex = (
  manifest: PolicyManifest,
): ResolutionIndex => {
  const definitions = [...manifest.policies].sort(
    (left, right) => (
      left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0
    ),
  );
  const byId = new Map(
    definitions.map((definition) => (
      [definition.id, definition] as const
    )),
  );
  const requiresById = new Map(
    definitions.map((definition) => (
      [definition.id, definition.requires] as const
    )),
  );

  const pairs = new Set<string>();
  const conflictPairs: ConflictPair[] = [];
  for (const definition of definitions) {
    for (const other of [...definition.conflictsWith].sort()) {
      const sortedPair = [definition.id, other].sort();
      const left = sortedPair[0];
      const right = sortedPair[1];
      if (left === undefined || right === undefined) {
        throw new Error('conflict pair must contain two ids');
      }
      const pair = left + '|' + right;
      if (pairs.has(pair)) continue;
      pairs.add(pair);
      conflictPairs.push({ left, right });
    }
  }

  return {
    definitions,
    byId,
    requiresById,
    conflictPairs,
  };
};
interface ConflictResult {
  readonly diagnostics: readonly PolicyDiagnostic[];
  readonly hasRequiredConflict: boolean;
  readonly hasPotentialConflict: boolean;
}

const collectConflicts = (
  index: ResolutionIndex,
  required: ReadonlySet<string>,
  candidate: ReadonlySet<string>,
): ConflictResult => {
  const diagnostics: PolicyDiagnostic[] = [];
  let hasRequiredConflict = false;
  let hasPotentialConflict = false;
  const included = new Set([
    ...required,
    ...candidate,
  ]);

  for (const pair of index.conflictPairs) {
    if (
      !included.has(pair.left)
      || !included.has(pair.right)
    ) {
      continue;
    }
    if (
      required.has(pair.left)
      && required.has(pair.right)
    ) {
      hasRequiredConflict = true;
      diagnostics.push(policyDiagnostic(
        'POLICY_CONFLICT',
        'error',
        'policies.conflictsWith',
        [pair.left, pair.right],
        [],
      ));
    } else {
      hasPotentialConflict = true;
      diagnostics.push(policyDiagnostic(
        'POTENTIAL_CONFLICT',
        'warning',
        'policies.conflictsWith',
        [pair.left, pair.right],
        [],
      ));
    }
  }

  return {
    diagnostics,
    hasRequiredConflict,
    hasPotentialConflict,
  };
};
const staleFactDiagnostics = (
  request: ResolveRequest,
): readonly PolicyDiagnostic[] => request.facts
  .filter((fact) => (
    fact.basis === 'verified'
    && fact.contextId !== request.contextId
  ))
  .map((fact) => policyDiagnostic(
    'STALE_FACT',
    'warning',
    'facts',
    [],
    [fact.id],
  ));

const resolveValidatedRequest = (
  index: ResolutionIndex,
  request: ResolveRequest,
): PolicyResolution => {
  const truthById = new Map<string, Truth>();
  const detailsById = new Map<
    string,
    ConditionEvaluation
  >();
  const requiredRoots = new Set<string>();
  const candidateRoots = new Set<string>();

  for (const definition of index.definitions) {
    const evaluation = evaluateValidatedPolicyConditionDetails(
      definition.when,
      request,
    );
    truthById.set(definition.id, evaluation.truth);
    detailsById.set(definition.id, evaluation);
    if (evaluation.truth === 'true') {
      requiredRoots.add(definition.id);
    }
    if (evaluation.truth === 'unknown') {
      candidateRoots.add(definition.id);
    }
  }

  const required = addClosure(
    requiredRoots,
    index.byId,
  );
  for (const id of required) {
    candidateRoots.delete(id);
  }

  const candidateClosure = addClosure(
    candidateRoots,
    index.byId,
  );
  const candidate = new Set(
    [...candidateClosure].filter(
      (id) => !required.has(id),
    ),
  );
  const included = new Set([
    ...required,
    ...candidate,
  ]);
  const excluded = new Set(
    index.definitions
      .filter((definition) => (
        truthById.get(definition.id) === 'false'
        && !included.has(definition.id)
      ))
      .map((definition) => definition.id),
  );

  const requiredIds = stableTopologicalOrder(
    required,
    index.requiresById,
  );
  const candidateIds = stableTopologicalOrder(
    candidate,
    index.requiresById,
  );
  const excludedIds = [...excluded].sort();

  const unresolvedFactIds = new Set<string>();
  let unresolvedScope = false;
  for (const id of candidate) {
    if (truthById.get(id) !== 'unknown') continue;
    const details = detailsById.get(id);
    if (details === undefined) continue;
    details.unresolvedFactIds.forEach(
      (factId) => unresolvedFactIds.add(factId),
    );
    unresolvedScope ||= details.unresolvedScope;
  }

  const staleDiagnostics = staleFactDiagnostics(request);
  for (const item of staleDiagnostics) {
    item.relatedIds.forEach(
      (factId) => unresolvedFactIds.add(factId),
    );
  }

  const directReasons = index.definitions.flatMap(
    (definition) => (
      detailsById.get(definition.id)?.reasons.map(
        (reason) => ({
          policyId: definition.id,
          kind: reason.kind,
          fromId: reason.fromId,
          evidenceIds: reason.evidenceIds,
        }),
      ) ?? []
    ),
  );
  const requiresReasons = collectRequiresReasons(
    included,
    index.byId,
  );
  const reasons = [
    ...directReasons,
    ...requiresReasons,
  ];
  const conflicts = collectConflicts(
    index,
    required,
    candidate,
  );
  const diagnostics = [
    ...staleDiagnostics,
    ...conflicts.diagnostics,
  ];

  let state: PolicyResolution['state'];
  if (conflicts.hasRequiredConflict) {
    state = 'conflict';
  } else if (
    candidate.size > 0
    || staleDiagnostics.length > 0
    || conflicts.hasPotentialConflict
  ) {
    state = 'needs-context';
  } else {
    state = 'ready';
  }

  return {
    schemaVersion: 1,
    state,
    contextId: request.contextId,
    requiredIds,
    candidateIds,
    excludedIds,
    unresolvedFactIds: [
      ...unresolvedFactIds,
    ].sort(),
    unresolvedScope,
    reasons,
    diagnostics,
  };
};

export interface ValidatedPolicyResolver {
  resolve(request: ResolveRequest): PolicyResolution;
}

export const createValidatedPolicyResolver = (
  manifest: PolicyManifest,
): ValidatedPolicyResolver => {
  const index = buildResolutionIndex(manifest);
  return {
    resolve: (request) => (
      resolveValidatedRequest(index, request)
    ),
  };
};
export const resolvePolicies = (
  manifestInput: PolicyManifest,
  requestInput: ResolveRequest,
): PolicyResolution => {
  const manifestValidation = validatePolicyManifest(
    manifestInput,
  );
  const contextId = typeof requestInput?.contextId === 'string'
    ? requestInput.contextId
    : '';
  if (!manifestValidation.ok) {
    return invalidResolution(
      contextId,
      manifestValidation.diagnostics,
    );
  }

  const requestValidation = validateResolveRequest(
    requestInput,
  );
  if (!requestValidation.ok) {
    return invalidResolution(
      contextId,
      requestValidation.diagnostics,
    );
  }

  return createValidatedPolicyResolver(
    manifestValidation.value,
  ).resolve(requestValidation.value);
};
