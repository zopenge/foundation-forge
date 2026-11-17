import { expect, it, vi } from 'vitest';
import { ScanFailureWitness } from '../src/node/managed-scan-witness.js';

// 纯路径契约：使用Node自己的POSIX解析器，不访问这些合成路径。
vi.mock('node:path', async importOriginal => {
  const path = await importOriginal<typeof import('node:path')>(); return { ...path, ...path.posix };
});
it('keeps a POSIX filename containing a backslash inside its checkout argument role', () => {
  const paths = { sourceRoot: '/owned', slotRoot: '/owned/slot', checkoutRoot: '/owned/slot/checkout',
    anchorPath: '/owned/anchor', ownershipPath: '/owned/slot/ownership.json', statePath: '/owned/slot/state.json',
    lockPath: '/owned/slot/run.lock', recoveryLockPath: '/owned/slot/recover.lock',
    sourceIdentity: { dev: '1', ino: '1' }, slotIdentity: { dev: '1', ino: '2' } };
  for (const [path, role] of [['/owned/slot/checkout/..\\file', 'checkout-payload'], ['/owned/slot/checkout/../file', 'unknown']] as const) {
    const error = Object.assign(new Error('owned'), { code: 'ENOENT', syscall: 'lstat', path });
    const witness = new ScanFailureWitness(0); witness.first(error, paths);
    expect(witness.snapshot().first?.role).toBe(role);
  }
});
