import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { collectSourceInventory } from '../src/node.js';
import { addCommittedFile, addFixtureSubmodule, createRepository, removeRepository, runGit } from './node-fixtures.js';
const roots: string[] = [];
const makeRoot = async (): Promise<string> => { const root = await createRepository(); roots.push(root); return root; };
afterEach(async () => { await Promise.all(roots.splice(0).map(removeRepository)); });

test('collects tracked and untracked non-ignored files with repository state', async () => {
  const root = await makeRoot();
  await addCommittedFile(root, 'src/tracked.ts');
  await writeFile(join(root, 'untracked.ts'), 'export {}\n', 'utf8');
  await mkdir(join(root, 'ignored')); await writeFile(join(root, 'ignored/hidden.ts'), '', 'utf8');
  const inventory = await collectSourceInventory({ sourceRoot: root });
  expect(inventory.issues).toEqual([]);
  expect(inventory.repositories).toHaveLength(1);
  expect(inventory.repositories[0]).toMatchObject({ path: '', initialized: true, branch: expect.any(String), dirty: true, parentGitlink: null });
  expect(inventory.entries.map(entry => [entry.projectPath, entry.tracked, entry.untracked])).toEqual([
    ['.gitignore', true, false], ['src/tracked.ts', true, false], ['untracked.ts', false, true],
  ]);
});

test('recurses initialized submodules and records parent gitlink', async () => {
  const root = await makeRoot(); const sub = await makeRoot();
  await addCommittedFile(sub, 'nested.ts');
  await addFixtureSubmodule(root, sub);
  await runGit(root, ['commit', '--quiet', '-am', 'submodule']);
  await writeFile(join(root, 'modules/lib/untracked.ts'), '', 'utf8');
  const inventory = await collectSourceInventory({ sourceRoot: root });
  expect(inventory.issues).toEqual([]);
  expect(inventory.repositories.map(value => value.path)).toEqual(['', 'modules/lib']);
  const nested = inventory.repositories[1];
  expect(nested?.parentGitlink).toBe(nested?.head);
  expect(inventory.entries.map(value => value.projectPath)).toContain('modules/lib/untracked.ts');
  expect(inventory.entries.map(value => value.projectPath)).not.toContain('modules/lib');
});

test('blocks an initialized submodule whose head differs from the parent gitlink', async () => {
  const root = await makeRoot(); const sub = await makeRoot();
  await addCommittedFile(sub, 'nested.ts');
  await addFixtureSubmodule(root, sub);
  await runGit(root, ['commit', '--quiet', '-am', 'submodule']);
  await writeFile(join(root, 'modules/lib/nested.ts'), 'changed\n', 'utf8');
  await runGit(join(root, 'modules/lib'), ['add', 'nested.ts']); await runGit(join(root, 'modules/lib'), ['commit', '--quiet', '-m', 'drift']);
  const inventory = await collectSourceInventory({ sourceRoot: root });
  expect(inventory.issues).toEqual([expect.objectContaining({ code: 'SUBMODULE_HEAD_MISMATCH', path: 'modules/lib', blocking: true })]);
});

test('allows an initialized submodule head mismatch only when explicitly requested', async () => {
  const root = await makeRoot(); const sub = await makeRoot();
  await addCommittedFile(sub, 'nested.ts');
  await addFixtureSubmodule(root, sub);
  await runGit(root, ['commit', '--quiet', '-am', 'submodule']);
  await writeFile(join(root, 'modules/lib/nested.ts'), 'changed\n', 'utf8');
  await runGit(join(root, 'modules/lib'), ['add', 'nested.ts']); await runGit(join(root, 'modules/lib'), ['commit', '--quiet', '-m', 'drift']);
  const inventory = await collectSourceInventory({ sourceRoot: root, submoduleHeadPolicy: 'allow-checked-out' });
  expect(inventory.issues).toEqual([]);
  expect(inventory.repositories[1]?.head).not.toBe(inventory.repositories[1]?.parentGitlink);
});

test('blocks declared but uninitialized submodules rather than silently skipping them', async () => {
  const root = await makeRoot(); const sub = await makeRoot();
  await addCommittedFile(sub, 'nested.ts');
  await addFixtureSubmodule(root, sub);
  await runGit(root, ['commit', '--quiet', '-am', 'submodule']);
  await runGit(root, ['submodule', 'deinit', '-f', 'modules/lib']);
  const inventory = await collectSourceInventory({ sourceRoot: root });
  expect(inventory.issues).toEqual([expect.objectContaining({ code: 'SUBMODULE_UNINITIALIZED', path: 'modules/lib', blocking: true })]);
});
