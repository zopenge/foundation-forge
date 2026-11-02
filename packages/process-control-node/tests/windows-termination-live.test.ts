import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { createWindowsProcessControl, createWindowsProcessIdentityReader } from '../src/index.js';
import { liveTerminationChild } from './helpers/live-termination-child.js';

test.runIf(process.platform === 'win32')('revalidates a real CIM start token through the narrow reader before terminating its own child', async context => {
  const fixture = liveTerminationChild(context), { child, closed } = fixture;
  try {
    await once(child, 'spawn');
    const pid = child.pid; if (!pid) throw new Error('fixture child unavailable');
    const provider = createWindowsProcessControl({ listenerBackend: 'netstat' });
    const processes = await provider.listProcesses({ pids: [pid], signal: fixture.signal });
    expect(processes).toHaveLength(1);
    const identity = processes[0]; if (!identity) throw new Error('fixture identity unavailable');
    expect(await createWindowsProcessIdentityReader().readIdentity({ pid, signal: fixture.signal }))
      .toEqual({ status: 'FOUND', identity: { pid, startToken: identity.startToken } });
    await expect(provider.terminateProcessTree({ process: identity, policy: { mode: 'force' }, signal: fixture.signal }))
      .resolves.toEqual({ pid, forced: true });
    await closed; expect(fixture.error()).toBeUndefined();
    const observed = await createWindowsProcessIdentityReader().readIdentity({ pid, signal: fixture.signal });
    if (observed.status === 'FOUND') expect(observed.identity.startToken).not.toBe(identity.startToken);
  } finally {
    await fixture.dispose();
  }
});

test('closes the real test child on cancellation and waits for its close event', async context => {
  const controller = new AbortController(), fixture = liveTerminationChild(context, controller.signal);
  try {
    await once(fixture.child, 'spawn');
    controller.abort();
    await vi.waitFor(() => expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true),
      { timeout: 1000, interval: 10 });
    await fixture.closed;
    await fixture.dispose();
  } finally { await fixture.dispose(); }
});
