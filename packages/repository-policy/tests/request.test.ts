import { describe, expect, it } from 'vitest';

import { validateResolveRequest } from '../src/request.js';
import { sampleRequest } from './support/sample.js';

const codes = (input: unknown): readonly string[] => (
  validateResolveRequest(input).diagnostics.map((diagnostic) => diagnostic.code)
);

const evidence = {
  id: 'evidence-1',
  contextId: 'fixture-1',
  sourceId: 'source-1',
  digest: 'sha256:fixture',
} as const;

describe('resolve request validation', () => {
  it('accepts the independent request fixture', () => {
    expect(validateResolveRequest(sampleRequest).ok).toBe(true);
  });

  it('rejects unknown fields and unsafe paths', () => {
    expect(codes({ ...sampleRequest, extra: true })).toContain('UNKNOWN_FIELD');
    expect(codes({
      ...sampleRequest,
      scope: { paths: [{ path: '../outside.ts', role: 'write' }], complete: true },
    })).toContain('INVALID_PATH');
  });

  it('accepts literal repository paths containing Next.js route brackets', () => {
    expect(validateResolveRequest({
      ...sampleRequest,
      scope: {
        paths: [{
          path: 'src/app/[locale]/(workspace)/app/page.tsx',
          role: 'write',
        }],
        complete: true,
      },
    }).ok).toBe(true);
  });

  it('rejects duplicate facts and evidence ids', () => {
    const fact = {
      id: 'api-impact',
      state: 'unknown',
      basis: 'unknown',
      contextId: 'fixture-1',
      evidenceIds: [],
    } as const;
    expect(codes({ ...sampleRequest, facts: [fact, fact] })).toContain('DUPLICATE_ID');
    expect(codes({ ...sampleRequest, evidence: [evidence, evidence] })).toContain('DUPLICATE_ID');
  });

  it('requires evidence for verified facts', () => {
    const fact = {
      id: 'api-impact',
      state: 'true',
      basis: 'verified',
      contextId: 'fixture-1',
      evidenceIds: [],
    } as const;
    expect(codes({ ...sampleRequest, facts: [fact] })).toContain('MISSING_EVIDENCE');
  });
  it('rejects verified references to missing evidence', () => {
    const fact = {
      id: 'api-impact',
      state: 'false',
      basis: 'verified',
      contextId: 'fixture-1',
      evidenceIds: ['missing'],
    } as const;
    expect(codes({
      ...sampleRequest,
      facts: [fact],
      evidence: [evidence],
    })).toContain('MISSING_EVIDENCE');
  });

  it('requires unknown-basis facts to have unknown state', () => {
    const fact = {
      id: 'api-impact',
      state: 'false',
      basis: 'unknown',
      contextId: 'fixture-1',
      evidenceIds: [],
    } as const;
    expect(codes({ ...sampleRequest, facts: [fact] })).toContain('INVALID_SCHEMA');
  });

  it('allows stale context ids structurally for later tri-state handling', () => {
    const fact = {
      id: 'api-impact',
      state: 'true',
      basis: 'verified',
      contextId: 'older-context',
      evidenceIds: ['evidence-1'],
    } as const;
    const staleEvidence = { ...evidence, contextId: 'older-context' };
    expect(validateResolveRequest({
      ...sampleRequest,
      facts: [fact],
      evidence: [staleEvidence],
    }).ok).toBe(true);
  });
});
