import { resolve } from 'node:path';

import type {
  PolicyDiagnostic,
  PolicyManifest,
} from '../contracts.js';
import { policyDiagnostic } from '../diagnostics.js';
import { validatePolicyManifest } from '../manifest.js';
import {
  resolveNodePolicyReadLimits,
  type NodePolicyCheckOptions,
  type PolicyCheckReport,
  type ResolvedNodePolicyReadLimits,
} from './contracts.js';
import { loadStrictJsonFile } from './load-json.js';
import {
  inspectRepositoryFile,
  readPolicySource,
  type RepositoryFileInfo,
} from './read-sources.js';

type ManifestLoadResult =
  | { readonly ok: true; readonly manifest: PolicyManifest }
  | { readonly ok: false; readonly diagnostics: readonly PolicyDiagnostic[] };

const diagnostic = (
  code: string,
  fieldPath: string,
  relatedIds: readonly string[] = [],
): PolicyDiagnostic => policyDiagnostic(code, 'error', fieldPath, [], relatedIds);
export const loadValidatedPolicyManifest = async (
  options: NodePolicyCheckOptions,
  limits: ResolvedNodePolicyReadLimits,
): Promise<ManifestLoadResult> => {
  const loaded = await loadStrictJsonFile(
    options.root,
    options.manifestPath,
    limits.manifestBytes,
    'manifestPath',
  );
  if (!loaded.ok) {
    return {
      ok: false,
      diagnostics: [diagnostic(loaded.code, 'manifestPath', [options.manifestPath])],
    };
  }

  const validated = validatePolicyManifest(loaded.value);
  if (!validated.ok) {
    return {
      ok: false,
      diagnostics: validated.diagnostics,
    };
  }
  return {
    ok: true,
    manifest: validated.value,
  };
};
const checkPolicySources = async (
  root: string,
  manifest: PolicyManifest,
  limits: ResolvedNodePolicyReadLimits,
): Promise<readonly PolicyDiagnostic[]> => {
  const diagnostics: PolicyDiagnostic[] = [];
  const policyIdsByPath = new Map<string, string[]>();

  for (const policy of manifest.policies) {
    const ids = policyIdsByPath.get(policy.source.path) ?? [];
    ids.push(policy.id);
    policyIdsByPath.set(policy.source.path, ids);
  }
  for (const check of manifest.checks) {
    if (check.kind !== 'document') continue;
    if (!policyIdsByPath.has(check.source.path)) {
      policyIdsByPath.set(check.source.path, []);
    }
  }

  const paths = [...policyIdsByPath.keys()].sort();
  const preflight = new Map<string, RepositoryFileInfo>();
  let totalBytes = 0;
  for (const path of paths) {
    const inspected = await inspectRepositoryFile(
      root,
      path,
      limits.sourceBytes,
      'source.path',
    );
    if (!inspected.ok) {
      diagnostics.push(inspected.diagnostic);
      continue;
    }
    preflight.set(path, inspected.value);
    totalBytes += inspected.value.size;
    if (totalBytes > limits.totalSourceBytes) {
      diagnostics.push(diagnostic(
        'INPUT_LIMIT',
        'limits.totalSourceBytes',
        [path],
      ));
      return diagnostics;
    }
  }
  if (diagnostics.length > 0) return diagnostics;

  for (const path of paths) {
    const ids = [...(policyIdsByPath.get(path) ?? [])].sort();
    const result = await readPolicySource(
      root,
      { path },
      ids,
      limits.sourceBytes,
      {},
      preflight.get(path),
    );
    if (!result.ok) diagnostics.push(result.diagnostic);
  }
  return diagnostics;
};
const checkPackageScripts = async (
  root: string,
  manifest: PolicyManifest,
  limits: ResolvedNodePolicyReadLimits,
): Promise<readonly PolicyDiagnostic[]> => {
  const diagnostics: PolicyDiagnostic[] = [];
  const cache = new Map<string, unknown>();

  for (const check of manifest.checks) {
    if (check.kind !== 'package-script') continue;

    let packageValue = cache.get(check.packageJson);
    if (packageValue === undefined) {
      const loaded = await loadStrictJsonFile(
        root,
        check.packageJson,
        limits.sourceBytes,
        'checks.packageJson',
      );
      if (!loaded.ok) {
        diagnostics.push(diagnostic(
          loaded.code,
          'checks.packageJson',
          [check.id, check.packageJson],
        ));
        continue;
      }
      packageValue = loaded.value;
      cache.set(check.packageJson, packageValue);
    }

    const scripts = (
      typeof packageValue === 'object'
      && packageValue !== null
      && !Array.isArray(packageValue)
      && 'scripts' in packageValue
    )
      ? (packageValue as { readonly scripts?: unknown }).scripts
      : undefined;
    const scriptValue = (
      typeof scripts === 'object'
      && scripts !== null
      && !Array.isArray(scripts)
    )
      ? (scripts as Record<string, unknown>)[check.script]
      : undefined;

    if (typeof scriptValue !== 'string' || scriptValue.length === 0) {
      diagnostics.push(diagnostic(
        'CHECK_TARGET_MISSING',
        'checks.script',
        [check.id, check.script],
      ));
    }
  }

  return diagnostics;
};

export const checkPolicyRepository = async (
  options: NodePolicyCheckOptions,
): Promise<PolicyCheckReport> => {
  const limits = resolveNodePolicyReadLimits(options.limits);
  if (limits === null) {
    return {
      state: 'failed',
      diagnostics: [diagnostic('INPUT_LIMIT', 'limits')],
    };
  }

  const root = resolve(options.root);
  const manifestPath = options.manifestPath;
  const loaded = await loadValidatedPolicyManifest({ root, manifestPath }, limits);
  if (!loaded.ok) {
    return {
      state: 'failed',
      diagnostics: loaded.diagnostics,
    };
  }
  const diagnostics = [
    ...await checkPolicySources(root, loaded.manifest, limits),
    ...await checkPackageScripts(root, loaded.manifest, limits),
  ];

  return {
    state: diagnostics.length === 0 ? 'passed' : 'failed',
    diagnostics,
  };
};
