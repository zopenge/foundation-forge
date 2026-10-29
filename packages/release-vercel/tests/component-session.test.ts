import { expect, it, vi } from 'vitest';
import { Execution } from '../src/node/execution.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { managedFixture } from './helpers/managed-fixture.js';
import { publicationComponentSession } from './helpers/component-session.js';
import { installReadQueryComponentExecution } from './helpers/component-command-runtime.mjs';

it.each(['session', 'worker'])('keeps mutations, unknown Git commands and application commands managed in the %s component boundary', async mode => {
  const f = await managedFixture(); let release: (() => Promise<void>) | undefined;
  let restoreComponent: (() => void) | undefined;
  try {
    const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), slot = await openManagedSlot(source, f.execution);
    release = slot.lock.release;
    const session = await createManagedSession(slot, 'publish'), calls: { kind: string; managed: boolean }[] = [];
    vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
      calls.push({ kind: args[0] ?? '', managed: this === session.execution }); return 'fixture';
    });
    vi.spyOn(Execution.prototype, 'streamGit').mockImplementation(async function (this: Execution, args) {
      calls.push({ kind: args[0] ?? '', managed: this === session.execution });
    });
    const run = vi.spyOn(session.execution, 'run').mockResolvedValue('fixture');
    const component = mode === 'session' ? publicationComponentSession(session) : session;
    if (mode === 'worker') restoreComponent = installReadQueryComponentExecution(Execution);
    await component.execution.observeCheckout(async () => {
      for (const args of [['rev-parse', 'HEAD'], ['config', '--get', 'remote.origin.url'], ['push'], ['fetch'], ['config', 'user.name', 'fixture'], ['future-command']]) {
        await component.execution.git(args);
      }
      await component.execution.streamGit(['ls-tree', '-z', 'HEAD'], () => {});
      await component.execution.streamGit(['future-stream'], () => {});
      await component.execution.run('check', { command: 'node' }, 'CHECK_FAILED');
    });
    expect(calls).toEqual([
      { kind: 'rev-parse', managed: false }, { kind: 'config', managed: false },
      { kind: 'push', managed: true }, { kind: 'fetch', managed: true },
      { kind: 'config', managed: true }, { kind: 'future-command', managed: true },
      { kind: 'ls-tree', managed: false }, { kind: 'future-stream', managed: true },
    ]);
    expect(run).toHaveBeenCalledOnce();
  } finally { restoreComponent?.(); vi.restoreAllMocks(); try { await release?.(); } finally { await f.dispose(); } }
});
