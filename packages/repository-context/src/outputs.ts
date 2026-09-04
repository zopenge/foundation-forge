import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';
import { compareGeneratedArtifactSnapshot, defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import type { RepositoryContextOutputComparison } from './contracts.js';

export function serializeRepositoryContextJson(value: unknown): string {
  return stringifyDeterministicJson(value, { space: 2, trailingNewline: true });
}

export function normalizeRepositoryContextNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

// JSON 字符串编码保留孤立代理码元，避免 UTF-8 编码把不同字符串合并为同一替换字符。
const comparisonContent = (value: string): string => JSON.stringify(normalizeRepositoryContextNewlines(value));
const encoder = new TextEncoder();

export function compareRepositoryContextOutputs({ expected, current }: { readonly expected: Readonly<Record<string, string>>; readonly current: Readonly<Record<string, string | null>> }): RepositoryContextOutputComparison {
  // 输出键属于调用者领域；内部编号只用于满足通用生成物的相对路径契约。
  const entries = Object.entries(expected).map(([path, content], index) => ({ path, artifactPath: String(index), content }));
  const plan = defineGeneratedArtifactPlan({
    artifacts: entries.map(entry => ({ path: entry.artifactPath, content: comparisonContent(entry.content) })),
  });
  const snapshot = entries.flatMap(entry => {
    const actual = Object.hasOwn(current, entry.path) ? current[entry.path] : undefined;
    return actual === null || actual === undefined ? [] : [{ path: entry.artifactPath, content: encoder.encode(comparisonContent(actual)) }];
  });
  const comparison = compareGeneratedArtifactSnapshot(plan, snapshot);
  const translatePaths = (paths: readonly string[]): string[] => {
    const selected = new Set(paths);
    return entries.filter(entry => selected.has(entry.artifactPath)).map(entry => entry.path).sort();
  };
  const unexpected = Object.keys(current).filter(path => current[path] !== null && !Object.hasOwn(expected, path)).sort();
  return {
    ok: comparison.ok && unexpected.length === 0,
    missing: translatePaths(comparison.missing),
    stale: translatePaths(comparison.stale),
    unexpected,
  };
}
