import { describe, expect, it } from 'vitest';

import { validatePolicyManifest } from '../src/index.js';
import { sampleManifest } from './support/sample.js';

const codes = (input: unknown): readonly string[] => {
  const result = validatePolicyManifest(input);
  return result.diagnostics.map((diagnostic) => diagnostic.code);
};

describe('policy manifest validation', () => {
  it('accepts the independent valid fixture', () => {
    const result = validatePolicyManifest(sampleManifest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(sampleManifest);
  });

  it('rejects unknown schema versions', () => {
    expect(codes({ ...sampleManifest, schemaVersion: 99 })).toContain('INVALID_SCHEMA');
  });

  it('rejects duplicate policy ids', () => {
    expect(codes({
      ...sampleManifest,
      policies: [...sampleManifest.policies, sampleManifest.policies[0]],
    })).toContain('DUPLICATE_ID');
  });
  it('rejects undeclared facts and empty clauses', () => {
    const api = sampleManifest.policies[1];
    if (!api) throw new Error('fixture missing api policy');
    expect(codes({
      ...sampleManifest,
      policies: [
        sampleManifest.policies[0],
        { ...api, when: { anyOf: [{ facts: [{ id: 'missing', equals: true }] }] } },
      ],
    })).toContain('UNDECLARED_FACT');
    expect(codes({
      ...sampleManifest,
      policies: [
        sampleManifest.policies[0],
        { ...api, when: { anyOf: [{}] } },
      ],
    })).toContain('EMPTY_CLAUSE');
  });

  it('rejects missing requirements and dependency cycles', () => {
    const base = sampleManifest.policies[0];
    const api = sampleManifest.policies[1];
    if (!base || !api) throw new Error('fixture policies missing');
    expect(codes({
      ...sampleManifest,
      policies: [base, { ...api, requires: ['missing'] }],
    })).toContain('MISSING_REQUIREMENT');
    expect(codes({
      ...sampleManifest,
      policies: [{ ...base, requires: ['api'] }, api],
    })).toContain('DEPENDENCY_CYCLE');
  });

  it('rejects unknown fields and unsafe source paths', () => {
    expect(codes({ ...sampleManifest, unexpected: true })).toContain('UNKNOWN_FIELD');
    const base = sampleManifest.policies[0];
    if (!base) throw new Error('fixture missing base policy');
    expect(codes({
      ...sampleManifest,
      policies: [{ ...base, source: { path: '../outside.md' } }, sampleManifest.policies[1]],
    })).toContain('INVALID_PATH');
  });

  it('rejects missing checks and duplicate check ids', () => {
    const base = sampleManifest.policies[0];
    if (!base) throw new Error('fixture missing base policy');
    const check = { id: 'lint', kind: 'package-script' as const, packageJson: 'package.json', script: 'lint' };
    expect(codes({
      ...sampleManifest,
      policies: [{ ...base, checkIds: ['missing'] }, sampleManifest.policies[1]],
    })).toContain('CHECK_TARGET_MISSING');
    expect(codes({ ...sampleManifest, checks: [check, check] })).toContain('DUPLICATE_ID');
  });
  it('rejects duplicate undirected conflicts and self-conflicts', () => {
    const base = sampleManifest.policies[0];
    const api = sampleManifest.policies[1];
    if (!base || !api) throw new Error('fixture policies missing');
    expect(codes({
      ...sampleManifest,
      policies: [
        { ...base, conflictsWith: ['api'] },
        { ...api, conflictsWith: ['base'] },
      ],
    })).toContain('DUPLICATE_RELATION');
    expect(codes({
      ...sampleManifest,
      policies: [{ ...base, conflictsWith: ['base'] }, api],
    })).toContain('INVALID_RELATION');
  });

  it('rejects empty policy manifests and unknown object fields recursively', () => {
    expect(codes({ ...sampleManifest, policies: [] })).toContain('INVALID_SCHEMA');
    const base = sampleManifest.policies[0];
    if (!base) throw new Error('fixture missing base policy');
    expect(codes({
      ...sampleManifest,
      policies: [{ ...base, source: { path: 'rules/base.md', extra: true } }, sampleManifest.policies[1]],
    })).toContain('UNKNOWN_FIELD');
  });
});
