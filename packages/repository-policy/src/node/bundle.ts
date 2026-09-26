import { resolve } from 'node:path';

import type {
  PolicyDiagnostic,
  PolicyManifest,
  PolicyResolution,
} from '../contracts.js';
import { policyDiagnostic } from '../diagnostics.js';
import { resolvePolicies } from '../resolve.js';
import { validateResolveRequest } from '../request.js';
import { loadValidatedPolicyManifest } from './check.js';
import {
  resolveNodePolicyReadLimits,
  type NodePolicyOptions,
  type PolicyBundle,
  type PolicyDocument,
} from './contracts.js';
import {
  calculateBundleDigest,
  compareIds,
  requestContextId,
  snapshotRequest,
} from './identity.js';
import {
  inspectRepositoryFile,
  readPolicySource,
  type RepositoryFileInfo,
} from './read-sources.js';
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

export const createFailedPolicyBundle = (
  contextId: string,
  diagnostics: readonly PolicyDiagnostic[],
  resolution = invalidResolution(contextId, diagnostics),
  documents: readonly PolicyDocument[] = [],
): PolicyBundle => ({
  resolution,
  documents,
  bundleDigest: null,
  deliveryComplete: false,
  diagnostics,
});
export const policyIdsBySelectedSource = (
  manifest: PolicyManifest,
  resolution: PolicyResolution,
): ReadonlyMap<string, readonly string[]> => {
  const selected = new Set([
    ...resolution.requiredIds,
    ...resolution.candidateIds,
  ]);
  const result = new Map<string, string[]>();
  for (const policy of manifest.policies) {
    if (!selected.has(policy.id)) continue;
    const ids = result.get(policy.source.path) ?? [];
    ids.push(policy.id);
    result.set(policy.source.path, ids);
  }
  for (const [path, ids] of result) {
    result.set(path, ids.sort(compareIds));
  }
  return result;
};
export const resolvePolicyBundle = async (
  options: NodePolicyOptions,
): Promise<PolicyBundle> => {
  const limits = resolveNodePolicyReadLimits(options.limits);
  if (limits === null) {
    const diagnostics = [
      policyDiagnostic('INPUT_LIMIT', 'error', 'limits'),
    ];
    return createFailedPolicyBundle(requestContextId(options.request), diagnostics);
  }
  const snapshot = snapshotRequest(options.request);
  const contextId = requestContextId(snapshot === null ? options.request : snapshot.value);
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
    return createFailedPolicyBundle(contextId, diagnostics);
  }

  const requestValidation = validateResolveRequest(snapshot.value);
  if (!requestValidation.ok) {
    return createFailedPolicyBundle(contextId, requestValidation.diagnostics);
  }

  const root = resolve(options.root);
  const manifestPath = options.manifestPath;
  const request = requestValidation.value;
  const loaded = await loadValidatedPolicyManifest({ root, manifestPath }, limits);
  if (!loaded.ok) {
    return createFailedPolicyBundle(contextId, loaded.diagnostics);
  }

  const manifest = loaded.manifest;
  const resolution = resolvePolicies(manifest, request);
  if (resolution.state === 'invalid') {
    return createFailedPolicyBundle(
      contextId,
      resolution.diagnostics,
      resolution,
    );
  }
  const sourcePolicies = policyIdsBySelectedSource(
    manifest,
    resolution,
  );
  const sourcePaths = [...sourcePolicies.keys()].sort(compareIds);

  const preflight = new Map<
    string,
    RepositoryFileInfo
  >();
  let totalBytes = 0;
  for (const path of sourcePaths) {
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
  for (const path of sourcePaths) {
    const read = await readPolicySource(
      root,
      { path },
      sourcePolicies.get(path) ?? [],
      limits.sourceBytes,
      {},
      preflight.get(path),
    );
    if (!read.ok) {
      sourceDiagnostics.push(read.diagnostic);
    } else {
      documents.push(read.document);
    }
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

  const sortedDocuments = documents.sort((left, right) => (
    compareIds(left.source.path, right.source.path)
  ));
  const bundleDigest = await calculateBundleDigest(
    manifest,
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
