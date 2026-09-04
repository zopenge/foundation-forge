import { describe, expect, test } from 'vitest';
import * as api from '../src/index.js';
import { profile, recipe } from './fixtures.js';

describe('registry', () => {
  test('keeps identifiers and copies caller arrays', () => {
    const input = { profiles: [profile], recipes: [{ ...recipe, sourceFiles: ['z', 'a', 'z'] }] };
    const registry = api.createRepositoryContextRegistry(input);
    input.recipes[0]?.sourceFiles.push('later');
    expect(registry.recipes.get('inspect')?.sourceFiles).toEqual(['z', 'a', 'z']);
    expect(registry.profiles.get('compact')).toEqual(profile);
  });
  test('rejects duplicate profile and recipe identifiers', () => {
    expect(() => api.createRepositoryContextRegistry({ profiles: [profile, profile], recipes: [] })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_PROFILE_ID' }));
    expect(() => api.createRepositoryContextRegistry({ profiles: [profile], recipes: [recipe, recipe] })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_RECIPE_ID' }));
  });
  test('rejects unknown profile references', () => {
    expect(() => api.createRepositoryContextRegistry({ profiles: [], recipes: [recipe] })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_PROFILE' }));
  });
  test.each([-1, 0.5, NaN, Infinity])('rejects invalid limit %s', value => {
    expect(() => api.createRepositoryContextRegistry({ profiles: [{ ...profile, maxSourceFiles: value }], recipes: [] })).toThrowError(expect.objectContaining({ code: 'INVALID_LIMIT' }));
  });
  test('rejects malformed registry fields', () => {
    expect(() => api.createRepositoryContextRegistry({ profiles: [{ ...profile, id: '' }], recipes: [] })).toThrowError(expect.objectContaining({ code: 'INVALID_REGISTRY' }));
    expect(() => api.createRepositoryContextRegistry({ profiles: [profile], recipes: [{ ...recipe, sourceFiles: JSON.parse('[null]') }] })).toThrowError(expect.objectContaining({ code: 'INVALID_REGISTRY' }));
  });
});

test.each(['null', '{}', '{"profiles":null,"recipes":[]}', '{"profiles":[null],"recipes":[]}', '{"profiles":[],"recipes":[null]}'])('rejects malformed container %s with structured errors', input => {
  expect(() => api.createRepositoryContextRegistry(JSON.parse(input))).toThrowError(expect.objectContaining({ code: 'INVALID_REGISTRY' }));
});

test('rejects sparse recipe arrays before copying them', () => {
  expect(() => api.createRepositoryContextRegistry({ profiles: [profile], recipes: [{ ...recipe, sourceFiles: Array<string>(1) }] })).toThrowError(expect.objectContaining({ code: 'INVALID_REGISTRY' }));
});
