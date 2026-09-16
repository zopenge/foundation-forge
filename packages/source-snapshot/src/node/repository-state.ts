import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';
import type { SnapshotRepository } from '../contracts.js';
import type { SourceInventory } from './contracts.js';

const encoder = new TextEncoder();
const inventoryIdentity = (inventory: SourceInventory): unknown => ({
  version: inventory.version,
  repositories: inventory.repositories.map(value => ({
    path: value.path,
    initialized: value.initialized,
    head: value.head,
    branch: value.branch,
    parentGitlink: value.parentGitlink,
    dirty: value.dirty,
    statusCount: value.statusCount,
  })),
  entries: inventory.entries.map(value => ({
    repositoryPath: value.repositoryPath,
    relativePath: value.relativePath,
    projectPath: value.projectPath,
    tracked: value.tracked,
    untracked: value.untracked,
    mode: value.mode,
    status: value.status,
    exists: value.exists,
    size: value.size,
    type: value.type,
  })),
  issues: inventory.issues.map(value => ({ ...value })),
});
export const calculateInventoryFingerprint = async (inventory: SourceInventory): Promise<string> => {
  const integrity = await calculateBytesIntegrity(encoder.encode(stringifyDeterministicJson(inventoryIdentity(inventory))));
  return integrity.sha256;
};

export const repositoryManifestInput = (inventory: SourceInventory): readonly SnapshotRepository[] => inventory.repositories
  .filter(value => value.initialized && value.head !== null && value.dirty !== null)
  .map(value => ({
    path: value.path,
    head: value.head as string,
    branch: value.branch,
    dirty: value.dirty as boolean,
    ...(value.parentGitlink !== null && value.parentGitlink !== value.head ? { parentGitlink: value.parentGitlink } : {}),
  }));
