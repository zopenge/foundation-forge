import assert from 'node:assert/strict';
import { createRepositoryInvestigator, searchEntities, validateCorpus } from '@openge/forge-repository-context';
import { extractCpp } from '@openge/forge-repository-context/adapters/cpp';

const source = {
  corpusId: 'consumer', generationId: 'g1', path: 'src/example.ts', sourceSha256: 'a'.repeat(64),
  normalizedSha256: null, snapshotId: null, lineStart: 1, lineEnd: 1,
};
const corpus = {
  corpusId: 'consumer', generationId: 'g1', corpusState: 'frozen', coverage: 'complete-in-declared-scope',
  entities: [{ id: 'symbol:example', kind: 'symbol', name: 'createExample', owner: null,
    signature: 'function createExample(): void', source, evidenceLevel: 'syntax' }],
  edges: [],
};
assert.deepEqual(validateCorpus(corpus), []);
assert.equal(searchEntities(corpus, { by: 'symbol', value: 'createExample' }).status, 'ok');

const investigator = createRepositoryInvestigator({
  corpus,
  route: 'investigate',
  readRanges: async (ranges) => ({
    schemaVersion: 1, status: 'ok', corpusId: 'consumer', generationId: 'g1', diagnostics: [],
    texts: ranges.map((range) => ({ source: range, path: range.path, lineStart: 1, lineEnd: 1,
      text: 'export function createExample(): void {}' })),
  }),
});
assert.equal((await investigator.investigate({ query: 'createExample' })).status, 'ok');

const cpp = extractCpp({
  path: 'include/example.hpp', text: 'class Example {};', corpusId: 'consumer', generationId: 'g1',
});
assert.equal(cpp.readiness, 'ready-for-lexical-evidence');
assert.equal(cpp.entities.some((entity) => entity.name === 'Example'), true);
