import { expect, test } from 'vitest';
import * as api from '../src/index.js';
import { profile } from './fixtures.js';

test('deduplicates after caller priority and before truncation without mutation', () => {
  const sourceFiles = Object.freeze(['z', 'z', 'a', 'b']);
  const result = api.buildRepositoryContextSelection({ profile, sourceFiles, symbols: ['Z', 'Z', 'A'], requiredContextFiles: ['route', 'route'], localContextFiles: ['near-b', 'route', 'near-a'], globalContextFiles: ['far'] });
  expect(result).toEqual({ contextFiles: ['route', 'near-b', 'near-a'], sourceFiles: ['z', 'a'], symbols: ['Z'] });
  expect(sourceFiles).toEqual(['z', 'z', 'a', 'b']);
  expect(api.stableUniqueRepositoryContextValues(['z', 'a', 'z'])).toEqual(['z', 'a']);
});
test('uses global context and disables symbols independently of the numeric limit', () => {
  expect(api.buildRepositoryContextSelection({ profile: { ...profile, impactScope: 'global', symbolScope: 'none' }, requiredContextFiles: ['route'], globalContextFiles: ['far'], localContextFiles: ['near'], symbols: ['Z'] })).toEqual({ contextFiles: ['route', 'far'], sourceFiles: [], symbols: [] });
  expect(api.buildRepositoryContextSelection({ profile: { ...profile, maxSymbols: 0 }, symbols: ['Z'] }).symbols).toEqual([]);
});
test('rejects invalid profiles rather than silently selecting a fallback', () => {
  expect(() => api.buildRepositoryContextSelection({ profile: { ...profile, maxSymbols: -1 } })).toThrowError(expect.objectContaining({ code: 'INVALID_LIMIT' }));
});

test('rejects sparse selection candidates before they can reach JSON output', () => {
  expect(() => api.buildRepositoryContextSelection({ profile, sourceFiles: Array<string>(1) })).toThrowError(expect.objectContaining({ code: 'INVALID_REGISTRY' }));
});
