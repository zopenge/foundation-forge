import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';
import type { RepositoryContextOutputComparison } from './contracts.js';

export function serializeRepositoryContextJson(value: unknown): string {
  return stringifyDeterministicJson(value, { space: 2, trailingNewline: true });
}

export function normalizeRepositoryContextNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function compareRepositoryContextOutputs({ expected, current }: { readonly expected: Readonly<Record<string, string>>; readonly current: Readonly<Record<string, string | null>> }): RepositoryContextOutputComparison {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const [path, value] of Object.entries(expected)) {
    const actual = Object.hasOwn(current, path) ? current[path] : undefined;
    if (actual === undefined || actual === null) missing.push(path);
    else if (normalizeRepositoryContextNewlines(actual) !== normalizeRepositoryContextNewlines(value)) stale.push(path);
  }
  const unexpected = Object.keys(current).filter(path => current[path] !== null && !Object.hasOwn(expected, path)).sort();
  return { ok: missing.length + stale.length + unexpected.length === 0, missing: missing.sort(), stale: stale.sort(), unexpected };
}
