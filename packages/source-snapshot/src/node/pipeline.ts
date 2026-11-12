import { readFile } from 'node:fs/promises';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type {
  RepositorySnapshotFreeze,
  RepositorySnapshotFreezeVerification,
  RepositorySnapshotPlanOptions,
} from './contracts.js';
import { collectSourceInventory } from './inventory.js';
import { calculateInventoryFingerprint } from './repository-state.js';
export const verifyRepositorySnapshotFreeze = async (
  options: RepositorySnapshotPlanOptions,
  freeze: RepositorySnapshotFreeze,
): Promise<RepositorySnapshotFreezeVerification> => {
  const inventory = await collectSourceInventory({
    sourceRoot: options.sourceRoot,
    ...(options.submoduleHeadPolicy === undefined ? {} : { submoduleHeadPolicy: options.submoduleHeadPolicy }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const inventoryChanged = await calculateInventoryFingerprint(inventory) !== freeze.inventoryFingerprint;
  const byPath = new Map(inventory.entries.map(value => [value.projectPath, value]));
  const changed: string[] = [];
  for (const frozen of freeze.files) {
    const current = byPath.get(frozen.path);
    if (current === undefined || !current.exists || current.type !== 'file') { changed.push(frozen.path); continue; }
    try {
      const integrity = await calculateBytesIntegrity(await readFile(current.absolutePath));
      if (integrity.sha256 !== frozen.sha256) changed.push(frozen.path);
    } catch { changed.push(frozen.path); }
  }
  const changedPaths = Object.freeze([...new Set(changed)].sort());
  return Object.freeze({ ok: !inventoryChanged && changedPaths.length === 0, inventoryChanged, changedPaths });
};
