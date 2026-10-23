import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { freezeManagedSource } from '../src/node/source.js';
import { resolveManagedPaths } from '../src/node/managed-paths.js';
import { git, managedFixture } from './helpers/managed-fixture.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };

it('accepts a real autocrlf checkout of committed ignore rules', async () => {
  const f = await fixture();
  git(f.cwd, 'config', 'core.autocrlf', 'true');
  await writeFile(resolve(f.cwd, '.git/info/attributes'), '.gitignore !text !eol\n');
  await unlink(resolve(f.cwd, '.gitignore'));
  git(f.cwd, 'checkout-index', '--force', '--', '.gitignore');
  git(f.cwd, 'add', '--', '.gitignore');
  expect(git(f.cwd, 'diff', '--cached', '--', '.gitignore')).toBe('');
  expect(git(f.cwd, 'status', '--porcelain=v1', '--untracked-files=no')).toBe('');
  expect(await readFile(resolve(f.cwd, '.gitignore'), 'utf8')).toBe('.tmp/\r\nnode_modules/\r\n');
  expect(git(f.cwd, 'diff', 'HEAD', '--', '.gitignore')).toBe('');
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(resolveManagedPaths(source, f.execution)).resolves.toMatchObject({ slotRoot: resolve(f.cwd, '.tmp/release-slot') });
});

it('rejects changed ignore rules even when their line endings are CRLF', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await writeFile(resolve(f.cwd, '.gitignore'), '.tmp/\r\nnode_modules/\r\nuncommitted/\r\n');
  await expect(resolveManagedPaths(source, f.execution)).rejects.toMatchObject({ code: 'SLOT_PATH', details: { reason: 'IGNORE_NOT_COMMITTED' } });
});

it('does not let a clean filter conceal changed ignore rules', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const filter = resolve(f.root, 'filter.cjs');
  await writeFile(filter, 'require("node:fs").readFileSync(0);process.stdout.write(".tmp/\\nnode_modules/\\n")');
  await writeFile(resolve(f.cwd, '.git/info/attributes'), '.gitignore filter=fixture\n');
  git(f.cwd, 'config', 'filter.fixture.clean', `"${process.execPath.replaceAll('\\', '/')}" "${filter.replaceAll('\\', '/')}"`);
  await writeFile(resolve(f.cwd, '.gitignore'), '.tmp/\nnode_modules/\nuncommitted/\n');
  expect(git(f.cwd, 'hash-object', '.gitignore')).toBe(git(f.cwd, 'rev-parse', 'HEAD:.gitignore'));
  expect(git(f.cwd, 'diff', 'HEAD', '--', '.gitignore')).toBe('');
  await expect(resolveManagedPaths(source, f.execution)).rejects.toMatchObject({ code: 'SLOT_PATH', details: { reason: 'IGNORE_NOT_COMMITTED' } });
});

it.each(['global', 'info-exclude'])('rejects management rules supplied only by %s', async mode => {
  const f = await fixture();
  await writeFile(resolve(f.cwd, '.gitignore'), 'node_modules/\n'); f.commit();
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const path = mode === 'global' ? resolve(f.root, 'global-ignore') : resolve(f.cwd, '.git/info/exclude');
  await writeFile(path, '.tmp/\n');
  if (mode === 'global') git(f.cwd, 'config', 'core.excludesFile', path);
  await expect(resolveManagedPaths(source, f.execution)).rejects.toMatchObject({ code: 'SLOT_PATH' });
});
