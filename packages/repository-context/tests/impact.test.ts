import { expect, test } from 'vitest';
import * as api from '../src/index.js';

test('closes diamonds and cycles once and sorts nodes by id', () => {
  const nodes = [ { id: 'z', dependsOn: ['b', 'a'], files: ['z.ts'] }, { id: 'b', dependsOn: ['a'], files: ['b.ts'] }, { id: 'a', dependsOn: ['z'], files: ['a.ts'] }, { id: 'unused', dependsOn: [], files: [] } ];
  expect(api.buildRepositoryContextImpactSlice({ nodes, rootIds: ['z', 'z'] }).map(node => node.id)).toEqual(['a', 'b', 'z']);
  expect(nodes.map(node => node.id)).toEqual(['z', 'b', 'a', 'unused']);
  expect(api.buildRepositoryContextImpactSlice({ nodes, rootIds: [] })).toEqual([]);
});
test('rejects unknown roots, dangling dependencies and duplicate nodes', () => {
  const node = { id: 'a', dependsOn: [], files: [] };
  expect(() => api.buildRepositoryContextImpactSlice({ nodes: [node], rootIds: ['missing'] })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_IMPACT_NODE' }));
  expect(() => api.buildRepositoryContextImpactSlice({ nodes: [{ ...node, dependsOn: ['missing'] }], rootIds: ['a'] })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_IMPACT_NODE' }));
  expect(() => api.buildRepositoryContextImpactSlice({ nodes: [node, node], rootIds: [] })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_IMPACT_NODE_ID' }));
});

test('rejects sparse dependency arrays as malformed registry data', () => {
  expect(() => api.buildRepositoryContextImpactSlice({ nodes: [{ id: 'a', dependsOn: Array<string>(1), files: [] }], rootIds: ['a'] })).toThrowError(expect.objectContaining({ code: 'INVALID_REGISTRY' }));
});
