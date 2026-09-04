import { describe, expect, it } from 'vitest';
import { compareGeneratedArtifactSnapshot, defineGeneratedArtifactPlan } from '../src/index.js';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
describe('compareGeneratedArtifactSnapshot', () => {
  it('reports missing, stale and retired files in deterministic order and ignores unmanaged files', () => {
    const plan = defineGeneratedArtifactPlan({ artifacts: [
      { path: 'missing/z', content: '' }, { path: 'missing/A', content: '' },
      { path: 'stale/z', content: 'a' }, { path: 'stale/A', content: 'b' },
    ], retiredPaths: ['old/z', 'old/A'] });
    const snapshot = ['stale/z', 'stale/A', 'old/z', 'old/A', 'unmanaged'].map(path => ({ path, content: bytes('other') }));
    expect(compareGeneratedArtifactSnapshot(plan, snapshot)).toEqual({ ok: false, missing: ['missing/A', 'missing/z'], stale: ['stale/A', 'stale/z'], retiredPresent: ['old/A', 'old/z'] });
    expect(compareGeneratedArtifactSnapshot(defineGeneratedArtifactPlan({ artifacts: [] }), snapshot)).toEqual({ ok: true, missing: [], stale: [], retiredPresent: [] });
  });
  it('compares UTF-8 and binary content exactly by default', () => {
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'utf8', content: '中文' }, { path: 'binary', content: new Uint8Array([0, 255]) }, { path: 'exact', content: 'a\n' }] });
    expect(compareGeneratedArtifactSnapshot(plan, [{ path: 'utf8', content: bytes('中文') }, { path: 'binary', content: new Uint8Array([0, 255]) }, { path: 'exact', content: bytes('a\r\n') }])).toEqual({ ok: false, missing: [], stale: ['exact'], retiredPresent: [] });
  });
  it('normalizes only newline sequences, preserving spaces and final newline', () => {
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: 'a\r\nb\rc\n', comparison: 'normalize-newlines' }] });
    expect(compareGeneratedArtifactSnapshot(plan, [{ path: 'x', content: bytes('a\nb\nc\n') }]).ok).toBe(true);
    expect(compareGeneratedArtifactSnapshot(plan, [{ path: 'x', content: bytes('a\nb\nc') }]).stale).toEqual(['x']);
    expect(compareGeneratedArtifactSnapshot(plan, [{ path: 'x', content: bytes('a \nb\nc\n') }]).stale).toEqual(['x']);
  });
  it('does not equate invalid UTF-8 with replacement characters', () => {
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: '\uFFFD', comparison: 'normalize-newlines' }] });
    expect(compareGeneratedArtifactSnapshot(plan, [{ path: 'x', content: new Uint8Array([255]) }]).stale).toEqual(['x']);
  });
});

describe('UTF-8 expected text semantics', () => {
  it('compares encoded surrogate replacement while preserving BOM and normalizing newlines', () => {
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: '\ufeff\ud800\r\n', comparison: 'normalize-newlines' }] });
    const content = new Uint8Array([239, 187, 191, 239, 191, 189, 10]);
    expect(compareGeneratedArtifactSnapshot(plan, [{ path: 'x', content }])).toEqual({ ok: true, missing: [], stale: [], retiredPresent: [] });
  });
});
