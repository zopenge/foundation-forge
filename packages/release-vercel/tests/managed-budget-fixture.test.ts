import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { observeBudget } from '../src/node/managed-budget.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';

const fixtures: Awaited<ReturnType<typeof managedBudgetFixture>>[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
const fixture = async () => { const value = await managedBudgetFixture(); fixtures.push(value); return value; };

it('prepares real budget files and atomic metadata without requiring Git', async () => {
  vi.stubEnv('PATH', '');
  const f = await fixture(), before = await observeBudget(f.paths, f.limits);
  expect((await lstat(f.paths.slotRoot)).isDirectory()).toBe(true);
  await writeFile(resolve(f.paths.slotRoot, 'payload'), Buffer.alloc(37));
  expect((await observeBudget(f.paths, f.limits)).bytes - before.bytes).toBe(37);
  await f.writeAnchor();
  expect(JSON.parse(await readFile(f.paths.anchorPath, 'utf8'))).toMatchObject({ schemaVersion: 2, sourceRoot: f.paths.sourceRoot });
  await f.lock.release();
});

it('cleans only its own fixture and creates fresh independent state on the next call', async () => {
  const first = await fixture(), second = await fixture();
  expect(second.paths.slotRoot).not.toBe(first.paths.slotRoot);
  await writeFile(resolve(second.paths.slotRoot, 'retained'), 'second fixture');
  await first.dispose();
  await expect(lstat(first.root)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(second.paths.slotRoot, 'retained'), 'utf8')).toBe('second fixture');
  await second.lock.release();
});
