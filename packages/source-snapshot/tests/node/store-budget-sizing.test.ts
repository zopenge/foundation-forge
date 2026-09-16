import { expect, test } from 'vitest';
import { assertProjectedSourceSnapshotStoreBudgetBySize } from '../../src/node/store-usage.js';
import type { ManagedStoreMeasurement } from '../../src/node/store-usage.js';

const current: ManagedStoreMeasurement = Object.freeze({
  files: Object.freeze([
    { path: 'objects/existing.md', byteLength: 100, category: 'object' as const },
    { path: '.source-snapshot-owner.json', byteLength: 20, category: 'state' as const },
  ]),
  managedFileCount: 2,
  managedBytes: 120,
  objectFileCount: 1,
  objectBytes: 100,
  snapshotFileCount: 0,
  snapshotBytes: 0,
  stateFileCount: 1,
  stateBytes: 20,
});

test('projects managed-store budgets from byte lengths without materializing content', () => {
  const result = assertProjectedSourceSnapshotStoreBudgetBySize(current, [
    { path: 'objects/existing.md', byteLength: 100 },
    { path: 'objects/new.md', byteLength: 250 },
    { path: 'snapshots/snapshot-a/INDEX.md', byteLength: 30 },
  ], { maxManagedFiles: 10, maxManagedBytes: 1_000 });
  expect(result).toEqual({ managedFileCount: 4, managedBytes: 400, newPhysicalBytes: 280 });
});
