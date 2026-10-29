import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { hasVerifiedManagedClosure } from '../src/node/managed-closure.js';

const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose(); });

it('prepares current session components without a Git repository and runs a real owned command', async () => {
  const f = await managedSessionFixture(); fixtures.push(f);
  await expect(readFile(resolve(f.cwd, '.git/HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(f.slot.paths.checkoutRoot);
  const session = await createManagedSession(f.slot, 'check');
  expect(await session.execution.run('component', { command: 'node', args: ['-e', 'process.stdout.write("real")'] }, 'CHECK_FAILED')).toBe('real');
  expect(session.state.schemaVersion).toBe(3);
  expect(session.state.processes.every(hasVerifiedManagedClosure)).toBe(true);
  await session.assertStopped(); await f.slot.lock.release();
});

it('keeps independently owned paths and exact raw-lock guards for component fixtures', async () => {
  const a = await managedSessionFixture(), b = await managedSessionFixture(); fixtures.push(a, b);
  expect(a.root).not.toBe(b.root); expect(a.slot.slotId).not.toBe(b.slot.slotId);
  await writeFile(a.slot.paths.lockPath, 'replacement');
  await expect(a.slot.lock.assertOwned()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  await b.slot.lock.assertOwned(); await b.slot.lock.release();
});
