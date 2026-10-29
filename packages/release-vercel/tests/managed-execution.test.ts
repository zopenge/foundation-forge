import { beforeEach, expect, it, vi } from 'vitest';
import { Execution } from '../src/node/execution.js';
import { createManagedExecution } from '../src/node/managed-execution.js';

const readers = vi.hoisted(() => ({ native: vi.fn(), windows: vi.fn(), posix: vi.fn() }));
vi.mock('@openge/forge-process-control-node', async importOriginal => ({
  ...await importOriginal<typeof import('@openge/forge-process-control-node')>(),
  createWindowsNativeProcessIdentityReader: readers.native, createWindowsProcessIdentityReader: readers.windows, createPosixProcessIdentityReader: readers.posix,
}));
beforeEach(() => { vi.resetAllMocks(); for (const reader of Object.values(readers)) reader.mockReturnValue({ readIdentity: vi.fn() }); });
it('explicitly chooses the managed reader while preserving the ordinary execution default', () => {
  const config = { limits: { commandMs: 15_000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } };
  createManagedExecution(process.cwd(), config, undefined, []);
  if (process.platform === 'win32') {
    expect(readers.native).toHaveBeenCalledOnce(); expect(readers.windows).not.toHaveBeenCalled();
  } else expect(readers.posix).toHaveBeenCalledOnce();
  new Execution(process.cwd(), config, undefined, []);
  if (process.platform === 'win32') { expect(readers.native).toHaveBeenCalledOnce(); expect(readers.windows).toHaveBeenCalledOnce(); }
  else expect(readers.posix).toHaveBeenCalledTimes(2);
});
