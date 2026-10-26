import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assertManagementUntracked } from '../src/node/managed-paths.js';
import { freezeManagedSource } from '../src/node/source.js';
import { ReleaseError } from '../src/node/errors.js';
import { git, managedFixture } from './helpers/managed-fixture.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
const fixture = async () => { const result = await managedFixture(); fixtures.push(result); return result; };

it('observes current index and HEAD together on every guard without repeated tree processes', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const stream = vi.spyOn(f.execution, 'streamGit');
  await expect(assertManagementUntracked(source, f.execution)).resolves.toBeUndefined();
  expect(stream).toHaveBeenCalledTimes(1);
  const path = '.tmp/release-slot/new.txt';
  await mkdir(resolve(f.cwd, '.tmp/release-slot'), { recursive: true }); await writeFile(resolve(f.cwd, path), 'tracked');
  git(f.cwd, 'add', '-f', path);
  await expect(assertManagementUntracked(source, f.execution)).rejects.toMatchObject({ code: 'SLOT_PATH', details: { reason: 'TRACKED_MANAGEMENT_PATH' } });
});

it.each(['.tmp/release-slot/file', '.tmp/forge-vercel-release/file', '.tmp'])('rejects HEAD tracking of %s even after staged removal', async path => {
  const f = await fixture();
  if (path !== '.tmp') await mkdir(resolve(f.cwd, path, '..'), { recursive: true });
  await writeFile(resolve(f.cwd, path), 'tracked'); git(f.cwd, 'add', '-f', path); git(f.cwd, 'commit', '-m', 'tracked management');
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  git(f.cwd, 'rm', '-r', '--cached', '--', path);
  await expect(assertManagementUntracked(source, f.execution)).rejects.toMatchObject({ code: 'SLOT_PATH', details: { reason: 'TRACKED_MANAGEMENT_PATH' } });
});

it('allows unrelated tracked siblings and observes HEAD changes between calls', async () => {
  const f = await fixture();
  await mkdir(resolve(f.cwd, '.tmp'), { recursive: true }); await writeFile(resolve(f.cwd, '.tmp/other'), 'unrelated');
  git(f.cwd, 'add', '-f', '.tmp/other'); git(f.cwd, 'commit', '-m', 'unrelated');
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(assertManagementUntracked(source, f.execution)).resolves.toBeUndefined();
  await mkdir(resolve(f.cwd, '.tmp/RELEASE-SLOT'), { recursive: true }); await writeFile(resolve(f.cwd, '.tmp/RELEASE-SLOT/file'), 'tracked');
  git(f.cwd, 'add', '-f', '.tmp/RELEASE-SLOT/file'); git(f.cwd, 'commit', '-m', 'later management');
  git(f.cwd, 'rm', '-r', '--cached', '.tmp/RELEASE-SLOT');
  if (process.platform === 'win32') await expect(assertManagementUntracked(source, f.execution)).rejects.toMatchObject({ code: 'SLOT_PATH' });
  else await expect(assertManagementUntracked(source, f.execution)).resolves.toBeUndefined();
});

it('preserves an unsuccessful Git observation instead of accepting an empty result', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const failure = new ReleaseError('PROCESS_STATE_UNKNOWN');
  const stream = vi.spyOn(f.execution, 'streamGit').mockRejectedValueOnce(failure);
  try { await expect(assertManagementUntracked(source, f.execution)).rejects.toBe(failure); }
  finally { stream.mockRestore(); }
});
