import { expect, test } from 'vitest';
import * as core from '../src/index.js';
import * as node from '../src/node.js';

const coreNames = ['readSnapshotCatalogText', 'buildSnapshotReadCatalog', 'resolveSnapshotCatalog', 'verifySnapshotReadCatalog',
  'buildSnapshotCoverage', 'resolveSnapshotCoverage', 'verifySnapshotCoverage',
  'buildSnapshotProvenance', 'verifySnapshotProvenance'];
const nodeNames = ['buildSnapshotCoverageFromPlan', 'buildSnapshotProvenanceFromPlan', 'prepareSnapshotWithProvenance'];

test.each(coreNames)('publishes the runtime-neutral %s contract from the root entry', name => {
  expect(Reflect.get(core, name)).toBeTypeOf('function');
});
test.each(nodeNames)('publishes the explicit Node %s contract only from the Node entry', name => {
  expect(Reflect.get(node, name)).toBeTypeOf('function');
  expect(Reflect.has(core, name)).toBe(false);
});
