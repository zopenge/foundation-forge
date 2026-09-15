import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SourceClassificationDecision, SourcePathEntry, SourceSnapshotPolicy, SourceSnapshotPolicyInput } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';

const freezeList = (values: readonly string[] | undefined, kind: 'extension' | 'basename' | 'prefix' | 'directory' | 'suffix'): readonly string[] => {
  const result = [...(values ?? [])].map(value => value.toLowerCase());
  for (const value of result) {
    if (value.length === 0) throw new SourceSnapshotError('INVALID_POLICY', { kind });
    if (kind === 'extension' && !/^\.[a-z0-9][a-z0-9._-]*$/u.test(value)) throw new SourceSnapshotError('INVALID_POLICY', { kind, value });
    if (kind === 'prefix') {
      const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
      try { validatePortableRelativePath(trimmed); } catch { throw new SourceSnapshotError('INVALID_POLICY', { kind, value }); }
    }
    if (kind === 'directory' && (value.includes('/') || value.includes('\\') || value === '.' || value === '..')) throw new SourceSnapshotError('INVALID_POLICY', { kind, value });
  }
  return Object.freeze([...new Set(result)].sort());
};
const freezeDecision = (value: SourceClassificationDecision): SourceClassificationDecision => {
  if (!['include','exclude','review'].includes(value.action) || typeof value.ruleId !== 'string' || value.ruleId.length === 0) throw new SourceSnapshotError('INVALID_POLICY');
  return Object.freeze({ action: value.action, ruleId: value.ruleId });
};
export const defineSourceSnapshotPolicy = (input: SourceSnapshotPolicyInput = {}): SourceSnapshotPolicy => {
  const binaryExtensions = freezeList(input.binaryExtensions, 'extension');
  const textExtensions = freezeList(input.textExtensions, 'extension');
  const overlap = new Set(binaryExtensions.filter(value => textExtensions.includes(value)));
  if (overlap.size > 0) throw new SourceSnapshotError('INVALID_POLICY', { overlap: [...overlap] });
  const extensionDecisions: Record<string, SourceClassificationDecision> = {};
  for (const [raw, decision] of Object.entries(input.extensionDecisions ?? {})) {
    const extension = raw.toLowerCase();
    if (!/^\.[a-z0-9][a-z0-9._-]*$/u.test(extension) || binaryExtensions.includes(extension) || textExtensions.includes(extension)) throw new SourceSnapshotError('INVALID_POLICY', { extension });
    extensionDecisions[extension] = freezeDecision(decision);
  }
  return Object.freeze({
    sensitiveBasenames: freezeList(input.sensitiveBasenames, 'basename'),
    sensitiveBasenamePrefixes: freezeList(input.sensitiveBasenamePrefixes, 'basename'),
    excludedDirectoryNames: freezeList(input.excludedDirectoryNames, 'directory'),
    excludedPathPrefixes: freezeList(input.excludedPathPrefixes, 'prefix'),
    excludedFileSuffixes: freezeList(input.excludedFileSuffixes, 'suffix'), binaryExtensions, textExtensions,
    textBasenames: freezeList(input.textBasenames, 'basename'),
    textPathPrefixes: freezeList(input.textPathPrefixes, 'prefix').map(value => value.endsWith('/') ? value : `${value}/`),
    extensionDecisions: Object.freeze(extensionDecisions),
  });
};
const decision = (action: SourceClassificationDecision['action'], ruleId: string): SourceClassificationDecision => Object.freeze({ action, ruleId });
export const classifySourcePath = (entry: SourcePathEntry, policy: SourceSnapshotPolicy): SourceClassificationDecision => {
  if (!entry.exists || entry.type === 'missing') return decision('exclude','missing-entry');
  if (entry.type !== 'file') return decision('exclude','non-file');
  let path: string; try { path = validatePortableRelativePath(entry.path).toLowerCase(); } catch { throw new SourceSnapshotError('INVALID_INPUT', { field: 'path' }); }
  const segments = path.split('/'); const basename = segments.at(-1) ?? '';
  if (policy.sensitiveBasenames.includes(basename) || policy.sensitiveBasenamePrefixes.some(prefix => basename.startsWith(prefix))) return decision('exclude','sensitive-path');
  if (policy.excludedPathPrefixes.some(prefix => path.startsWith(prefix))) return decision('exclude','excluded-path-prefix');
  if (segments.some(segment => policy.excludedDirectoryNames.includes(segment))) return decision('exclude','excluded-directory');
  if (policy.excludedFileSuffixes.some(suffix => path.endsWith(suffix))) return decision('exclude','excluded-suffix');
  const custom = Object.entries(policy.extensionDecisions).find(([extension]) => basename.endsWith(extension))?.[1];
  if (custom !== undefined) return custom;
  if (policy.binaryExtensions.some(extension => basename.endsWith(extension))) return decision('exclude','binary-extension');
  if (policy.textPathPrefixes.some(prefix => path.startsWith(prefix)) || policy.textExtensions.some(extension => basename.endsWith(extension)) || policy.textBasenames.includes(basename)) return decision('include','text');
  return decision('review','unknown-file-type');
};
