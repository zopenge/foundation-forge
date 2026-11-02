import { beforeEach, expect, it, vi } from 'vitest';
import { Execution } from '../src/node/execution.js';
import { createManagedExecution } from '../src/node/managed-execution.js';

const readers = vi.hoisted(() => ({ native: vi.fn(), windows: vi.fn(), posix: vi.fn() }));
const control = vi.hoisted(() => vi.fn());
vi.mock('@openge/forge-process-control-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-process-control-node')>();
  return { ...actual,
    createWindowsNativeProcessIdentityReader: readers.native, createWindowsProcessIdentityReader: readers.windows, createPosixProcessIdentityReader: readers.posix,
    createWindowsProcessControl: (...args: Parameters<typeof actual.createWindowsProcessControl>) => {
      control(...args); return actual.createWindowsProcessControl(...args);
    },
  };
});
beforeEach(() => { vi.resetAllMocks(); for (const reader of Object.values(readers)) reader.mockImplementation(() => ({ readIdentity: vi.fn() })); });
it('explicitly shares the native reader with Windows termination in both execution modes', () => {
  const config = { limits: { commandMs: 15_000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } };
  createManagedExecution(process.cwd(), config, undefined, []);
  if (process.platform === 'win32') {
    expect(readers.native).toHaveBeenCalledOnce(); expect(readers.windows).not.toHaveBeenCalled();
  } else expect(readers.posix).toHaveBeenCalledOnce();
  new Execution(process.cwd(), config, undefined, []);
  if (process.platform === 'win32') {
    expect(readers.native).toHaveBeenCalledTimes(2); expect(readers.windows).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledTimes(2);
    expect(control).toHaveBeenNthCalledWith(1, { listenerBackend: 'netstat', identityReader: readers.native.mock.results[0]?.value });
    expect(control).toHaveBeenNthCalledWith(2, { listenerBackend: 'netstat', identityReader: readers.native.mock.results[1]?.value });
    expect(readers.native.mock.results[0]?.value).not.toBe(readers.native.mock.results[1]?.value);
  } else {
    expect(readers.posix).toHaveBeenCalledTimes(2); expect(control).not.toHaveBeenCalled();
    expect(readers.native).not.toHaveBeenCalled(); expect(readers.windows).not.toHaveBeenCalled();
  }
});
