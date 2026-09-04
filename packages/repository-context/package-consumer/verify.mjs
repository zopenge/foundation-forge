import assert from 'node:assert/strict';
import { buildRepositoryContextSelection, createRepositoryContextRegistry, buildRepositoryContextImpactSlice, calculateRepositoryContextReductionPercent, compareRepositoryContextOutputs, evaluateRepositoryContextBudget, serializeRepositoryContextJson } from '@openge/forge-repository-context';

const profile = { id: 'compact', impactScope: 'local', maxSourceFiles: 2, maxSymbols: 1, symbolScope: 'local' };
const registry = createRepositoryContextRegistry({ profiles: [profile], recipes: [] });
assert.equal(registry.profiles.size, 1);
assert.deepEqual(buildRepositoryContextSelection({ profile, sourceFiles: ['b', 'b', 'a'] }).sourceFiles, ['b', 'a']);
assert.equal(calculateRepositoryContextReductionPercent(100, 10), 90);
assert.deepEqual(buildRepositoryContextImpactSlice({ nodes: [{ id: 'a', dependsOn: ['a'], files: [] }], rootIds: ['a'] }).map(node => node.id), ['a']);
assert.deepEqual(evaluateRepositoryContextBudget({ policy: { maxSourceFiles: 1, maxSymbols: 1 }, metrics: { sourceFileCount: 2, symbolCount: 0 } }), [{ code: 'SOURCE_FILE_BUDGET_EXCEEDED', actual: 2, limit: 1 }]);
const output = serializeRepositoryContextJson({ b: 2, a: 1 });
assert.equal(compareRepositoryContextOutputs({ expected: { output }, current: { output } }).ok, true);
