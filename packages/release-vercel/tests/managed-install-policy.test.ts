import { link, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareCheckout, prepareEnvironment } from '../src/node/managed-checkout.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { freezeManagedSource } from '../src/node/source.js';
import { commandComponentSession } from './helpers/component-session.js';
import { git, managedFixture } from './helpers/managed-fixture.js';

it('uses copy for real Windows managed pnpm installs while preserving the checkout and lock', async () => {
  const f = await managedFixture();
  try {
    const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
    const slot = await openManagedSlot(source, f.execution);
    try {
      const session = commandComponentSession(await createManagedSession(slot, 'check'));
      await prepareCheckout(session);
      const lockPath = resolve(slot.paths.checkoutRoot, 'pnpm-lock.yaml'), lock = await readFile(lockPath);
      const execute = session.execution.run.bind(session.execution), installs: string[][] = [];
      vi.spyOn(session.execution, 'run').mockImplementation(async (step, command, code, environment) => {
        if (step === 'install') {
          installs.push([...(command.args ?? [])]);
          expect(command.args).toEqual(['install', '--frozen-lockfile', ...(process.platform === 'win32' ? ['--package-import-method=copy'] : [])]);
        }
        return execute(step, command, code, environment);
      });
      const cached = resolve(slot.paths.checkoutRoot, 'node_modules/owned-cache-marker');
      await mkdir(resolve(cached, '..'), { recursive: true });
      await writeFile(cached, 'preserve existing cache');
      const oldStore = resolve(f.root, 'old-store-entry'), oldDependency = resolve(slot.paths.checkoutRoot, 'node_modules/old-hardlink');
      await writeFile(oldStore, 'retained previous installation'); await link(oldStore, oldDependency);
      const oldIdentity = await lstat(oldDependency, { bigint: true });
      await prepareEnvironment(session);
      await prepareEnvironment(session);
      expect(installs).toHaveLength(2);
      expect(await readFile(cached, 'utf8')).toBe('preserve existing cache');
      const retained = await lstat(oldDependency, { bigint: true });
      expect({ dev: retained.dev, ino: retained.ino, nlink: retained.nlink }).toEqual({ dev: oldIdentity.dev, ino: oldIdentity.ino, nlink: 2n });
      expect(await readFile(oldStore, 'utf8')).toBe('retained previous installation');
      expect(await readFile(lockPath)).toEqual(lock);
      expect(git(slot.paths.checkoutRoot, 'rev-parse', 'HEAD')).toBe(source.sha);
      expect(git(slot.paths.checkoutRoot, 'status', '--porcelain=v1')).toBe('');
      expect(git(f.cwd, 'status', '--porcelain=v1')).toBe('');
    } finally { await slot.lock.release(); }
  } finally { await f.dispose(); }
});
