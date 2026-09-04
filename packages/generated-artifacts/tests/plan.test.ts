import { describe, expect, it } from 'vitest';
import { defineGeneratedArtifactPlan, type GeneratedArtifactDefinition } from '../src/index.js';

describe('defineGeneratedArtifactPlan', () => {
  it('sorts portable paths by UTF-16 code units without guessing case sensitivity', () => {
    const plan = defineGeneratedArtifactPlan({ artifacts: [
      { path: 'z/out.txt', content: 'z' }, { path: 'a.txt', content: '' },
      { path: 'A.txt', content: '' }, { path: 'ä.txt', content: '' },
    ], retiredPaths: ['old/z', 'old/A'] });
    expect(plan.artifacts.map(item => item.path)).toEqual(['A.txt', 'a.txt', 'z/out.txt', 'ä.txt']);
    expect(plan.retiredPaths).toEqual(['old/A', 'old/z']);
  });
  it.each(['', '.', '..', '../a', 'a/../b', '/a', 'C:/a', 'C:a', 'a//b', 'a/', 'a/./b', 'a\\b', '\0', 'a:b', 'a.', 'a ', 'CON', 'nul.txt'])('rejects unsafe path %j', path => {
    expect(() => defineGeneratedArtifactPlan({ artifacts: [{ path, content: '' }] })).toThrow(expect.objectContaining({ code: 'GENERATED_ARTIFACT_INVALID_PATH' }));
    expect(() => defineGeneratedArtifactPlan({ artifacts: [], retiredPaths: [path] })).toThrow(expect.objectContaining({ code: 'GENERATED_ARTIFACT_INVALID_PATH' }));
  });
  it('rejects duplicates in either list and expected/retired overlap', () => {
    expect(() => defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: '' }, { path: 'x', content: '' }] })).toThrow(expect.objectContaining({ code: 'GENERATED_ARTIFACT_DUPLICATE_PATH' }));
    expect(() => defineGeneratedArtifactPlan({ artifacts: [], retiredPaths: ['x', 'x'] })).toThrow(expect.objectContaining({ code: 'GENERATED_ARTIFACT_DUPLICATE_PATH' }));
    expect(() => defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: '' }], retiredPaths: ['x'] })).toThrow(expect.objectContaining({ code: 'GENERATED_ARTIFACT_EXPECTED_RETIRED_OVERLAP' }));
  });
  it('copies caller arrays, definitions, and byte content', () => {
    const content = new Uint8Array([1, 2]);
    const artifacts: GeneratedArtifactDefinition[] = [{ path: 'x', content }];
    const retiredPaths = ['old'];
    const plan = defineGeneratedArtifactPlan({ artifacts, retiredPaths });
    content[0] = 9; artifacts[0] = { path: 'y', content: '' }; retiredPaths.push('later');
    expect(plan.artifacts).toEqual([{ path: 'x', content: new Uint8Array([1, 2]), comparison: 'exact' }]);
    expect(plan.retiredPaths).toEqual(['old']);
  });
  it('rejects non-content and binary newline normalization', () => {
    const malformed = JSON.parse('{"path":"x","content":null}') as GeneratedArtifactDefinition;
    expect(() => defineGeneratedArtifactPlan({ artifacts: [malformed] })).toThrow(expect.objectContaining({ code: 'GENERATED_ARTIFACT_INVALID_CONTENT' }));
    expect(() => defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: new Uint8Array(), comparison: 'normalize-newlines' }] })).toThrow(expect.objectContaining({ code: 'GENERATED_ARTIFACT_INVALID_CONTENT' }));
  });
});
