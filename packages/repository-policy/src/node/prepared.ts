import { resolve } from 'node:path';

import type {
  PolicyDiagnostic,
  ResolveRequest,
} from '../contracts.js';
import { policyDiagnostic } from '../diagnostics.js';
import {
  createValidatedPolicyResolver,
  type ValidatedPolicyResolver,
} from '../resolve.js';
import { validateResolveRequest } from '../request.js';
import {
  createFailedPolicyBundle,
  policyIdsBySelectedSource,
} from './bundle.js';
import { loadValidatedPolicyManifest } from './check.js';
import {
  resolveNodePolicyReadLimits,
  type PolicyBundle,
  type PreparePolicyRepositoryOptions,
  type PolicyDocument,
  type PreparePolicyRepositoryResult,
  type ResolvedNodePolicyReadLimits,
} from './contracts.js';
import {
  createBundleDigestCalculator,
  compareIds,
  requestContextId,
  snapshotRequest,
} from './identity.js';
import {
  inspectRepositoryFile,
  readPolicySource,
  type RepositoryFileInfo,
  type SourceReadResult,
} from './read-sources.js';
const loadCachedSource = async (
  root: string,
  path: string,
  limits: ResolvedNodePolicyReadLimits,
  cache: Map<string, PolicyDocument>,
  pending: Map<string, Promise<SourceReadResult>>,
  preflight?: RepositoryFileInfo,
): Promise<SourceReadResult> => {
  const cached = cache.get(path);
  if (cached !== undefined) {
    return {
      ok: true,
      document: cached,
    };
  }

  let current = pending.get(path);
  if (current === undefined) {
    current = readPolicySource(
      root,
      { path },
      [],
      limits.sourceBytes,
      {},
      preflight,
    );
    pending.set(path, current);
  }

  const result = await current;
  pending.delete(path);
  if (result.ok) {
    cache.set(path, {
      ...result.document,
      policyIds: [],
    });
  }
  return result;
};
const resolvePreparedRequest = async (
  root: string,
  manifest: Awaited<ReturnType<typeof loadValidatedPolicyManifest>> & {
    readonly ok: true;
  },
  resolver: ValidatedPolicyResolver,
  calculateDigest: ReturnType<typeof createBundleDigestCalculator>,
  limits: ResolvedNodePolicyReadLimits,
  cache: Map<string, PolicyDocument>,
  pending: Map<string, Promise<SourceReadResult>>,
  input: ResolveRequest,
): Promise<PolicyBundle> => {
  const snapshot = snapshotRequest(input);
  const contextId = requestContextId(snapshot === null ? input : snapshot.value);
  if (
    snapshot === null
    || snapshot.byteLength > limits.requestBytes
  ) {
    const diagnostics = [
      policyDiagnostic(
        snapshot === null ? 'INVALID_SCHEMA' : 'INPUT_LIMIT',
        'error',
        'request',
      ),
    ];
    return createFailedPolicyBundle(
      contextId,
      diagnostics,
    );
  }

  const requestValidation = validateResolveRequest(snapshot.value);
  if (!requestValidation.ok) {
    return createFailedPolicyBundle(
      contextId,
      requestValidation.diagnostics,
    );
  }
  const request = requestValidation.value;
  const resolution = resolver.resolve(request);
  if (resolution.state === 'invalid') {
    return createFailedPolicyBundle(
      contextId,
      resolution.diagnostics,
      resolution,
    );
  }

  const sourcePolicies = policyIdsBySelectedSource(
    manifest.manifest,
    resolution,
  );
  const sourcePaths = [
    ...sourcePolicies.keys(),
  ].sort(compareIds);

  const preflight = new Map<
    string,
    RepositoryFileInfo
  >();
  let totalBytes = 0;
  for (const path of sourcePaths) {
    const cached = cache.get(path);
    if (cached !== undefined) {
      totalBytes += cached.utf8Bytes;
    } else {
      const inspected = await inspectRepositoryFile(
        root,
        path,
        limits.sourceBytes,
        'source.path',
      );
      if (!inspected.ok) {
        const diagnostics = [
          ...resolution.diagnostics,
          inspected.diagnostic,
        ];
        return createFailedPolicyBundle(
          contextId,
          diagnostics,
          resolution,
        );
      }
      preflight.set(path, inspected.value);
      totalBytes += inspected.value.size;
    }
    if (totalBytes > limits.totalSourceBytes) {
      const diagnostics = [
        ...resolution.diagnostics,
        policyDiagnostic(
          'INPUT_LIMIT',
          'error',
          'limits.totalSourceBytes',
          [],
          [path],
        ),
      ];
      return createFailedPolicyBundle(
        contextId,
        diagnostics,
        resolution,
      );
    }
  }

  const documents: PolicyDocument[] = [];
  const sourceDiagnostics: PolicyDiagnostic[] = [];
  let deliveredBytes = 0;
  for (const path of sourcePaths) {
    const read = await loadCachedSource(
      root,
      path,
      limits,
      cache,
      pending,
      preflight.get(path),
    );
    if (!read.ok) {
      sourceDiagnostics.push({
        ...read.diagnostic,
        policyIds: sourcePolicies.get(path) ?? [],
      });
      continue;
    }
    deliveredBytes += read.document.utf8Bytes;
    if (deliveredBytes > limits.totalSourceBytes) {
      return createFailedPolicyBundle(
        contextId,
        [
          ...resolution.diagnostics,
          policyDiagnostic('INPUT_LIMIT', 'error', 'limits.totalSourceBytes', [], [path]),
        ],
        resolution,
        documents,
      );
    }
    documents.push({
      ...read.document,
      source: { ...read.document.source },
      policyIds: [
        ...(sourcePolicies.get(path) ?? []),
      ],
    });
  }
  if (sourceDiagnostics.length > 0) {
    const diagnostics = [
      ...resolution.diagnostics,
      ...sourceDiagnostics,
    ];
    return createFailedPolicyBundle(
      contextId,
      diagnostics,
      resolution,
      documents,
    );
  }

  const sortedDocuments = documents.sort(
    (left, right) => compareIds(
      left.source.path,
      right.source.path,
    ),
  );
  const bundleDigest = await calculateDigest(
    request,
    sortedDocuments,
  );
  return {
    resolution,
    documents: sortedDocuments,
    bundleDigest,
    deliveryComplete: true,
    diagnostics: resolution.diagnostics,
  };
};

const preloadPolicySources = async (
  root: string,
  manifest: Awaited<ReturnType<typeof loadValidatedPolicyManifest>> & {
    readonly ok: true;
  },
  limits: ResolvedNodePolicyReadLimits,
  cache: Map<string, PolicyDocument>,
  pending: Map<string, Promise<SourceReadResult>>,
): Promise<readonly PolicyDiagnostic[]> => {
  const policyIdsByPath = new Map<string, string[]>();
  for (const policy of manifest.manifest.policies) {
    const ids = policyIdsByPath.get(
      policy.source.path,
    ) ?? [];
    ids.push(policy.id);
    policyIdsByPath.set(policy.source.path, ids);
  }

  const paths = [...policyIdsByPath.keys()].sort(
    compareIds,
  );
  const inspected = await Promise.all(
    paths.map((path) => inspectRepositoryFile(
      root,
      path,
      limits.sourceBytes,
      'source.path',
    )),
  );

  const diagnostics: PolicyDiagnostic[] = [];
  const preflight = new Map<
    string,
    RepositoryFileInfo
  >();
  let totalBytes = 0;

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const result = inspected[index];
    if (path === undefined || result === undefined) {
      throw new Error('preload inspection index mismatch');
    }
    if (!result.ok) {
      diagnostics.push({
        ...result.diagnostic,
        policyIds: policyIdsByPath.get(path) ?? [],
      });
      continue;
    }
    preflight.set(path, result.value);
    totalBytes += result.value.size;
  }

  if (diagnostics.length > 0) {
    return diagnostics;
  }
  if (totalBytes > limits.totalSourceBytes) {
    return [
      policyDiagnostic(
        'INPUT_LIMIT',
        'error',
        'limits.totalSourceBytes',
        [],
        paths,
      ),
    ];
  }

  const reads = await Promise.all(
    paths.map((path) => loadCachedSource(
      root,
      path,
      limits,
      cache,
      pending,
      preflight.get(path),
    )),
  );

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const result = reads[index];
    if (
      path === undefined
      || result === undefined
      || result.ok
    ) {
      continue;
    }
    diagnostics.push({
      ...result.diagnostic,
      policyIds: policyIdsByPath.get(path) ?? [],
    });
  }

  return diagnostics;
};

export const preparePolicyRepository = async (
  options: PreparePolicyRepositoryOptions,
): Promise<PreparePolicyRepositoryResult> => {
  const { manifestPath, preload } = options;
  if (
    preload !== undefined
    && preload !== 'none'
    && preload !== 'policy-sources'
  ) {
    return {
      ok: false,
      diagnostics: [
        policyDiagnostic(
          'INVALID_SCHEMA',
          'error',
          'preload',
        ),
      ],
    };
  }

  const limits = resolveNodePolicyReadLimits(
    options.limits,
  );
  if (limits === null) {
    return {
      ok: false,
      diagnostics: [
        policyDiagnostic(
          'INPUT_LIMIT',
          'error',
          'limits',
        ),
      ],
    };
  }
  const root = resolve(options.root);
  const loaded = await loadValidatedPolicyManifest(
    { root, manifestPath },
    limits,
  );
  if (!loaded.ok) {
    return loaded;
  }

  const resolver = createValidatedPolicyResolver(
    loaded.manifest,
  );
  const calculateDigest = createBundleDigestCalculator(loaded.manifest);
  const cache = new Map<string, PolicyDocument>();
  const pending = new Map<
    string,
    Promise<SourceReadResult>
  >();

  if (preload === 'policy-sources') {
    const diagnostics = await preloadPolicySources(
      root,
      loaded,
      limits,
      cache,
      pending,
    );
    if (diagnostics.length > 0) {
      return {
        ok: false,
        diagnostics,
      };
    }
  }

  return {
    ok: true,
    repository: {
      root,
      manifestPath,
      resolve: (request) => resolvePreparedRequest(
        root,
        loaded,
        resolver,
        calculateDigest,
        limits,
        cache,
        pending,
        request,
      ),
    },
  };
};
