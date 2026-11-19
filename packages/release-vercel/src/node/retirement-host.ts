import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { acquireLocalDirectoryLease, type LocalDirectoryIdentity } from '@openge/forge-process-control-node';
import { assertActive, record, ReleaseError } from './errors.js';

export const retirementLeaseNamespace = 'FoundationForge.Retirement';
export interface RetirementHost {
  readonly platform: 'win32' | 'linux';
  readonly hostId: string;
}
export const acquireManagedCoordinatorLease = (paths: { readonly slotRoot: string; readonly slotIdentity: LocalDirectoryIdentity },
  host: RetirementHost, signal?: AbortSignal) =>
  acquireLocalDirectoryLease(paths.slotRoot, { scope: { namespace: retirementLeaseNamespace, discriminator: host.hostId },
    expectedIdentity: paths.slotIdentity, signal });
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export function validRetirementHost(value: unknown): value is RetirementHost {
  const item = record(value);
  return (item.platform === 'win32' || item.platform === 'linux') && typeof item.hostId === 'string' && /^[a-f0-9]{64}$/u.test(item.hostId);
}
export async function readRetirementHost(signal?: AbortSignal): Promise<RetirementHost> {
  assertActive(signal);
  const platform = process.platform;
  if (!['win32', 'linux'].includes(platform)) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_HOST' });
  try {
    let machine: string;
    if (platform === 'win32') {
      const result = await promisify(execFile)('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4096, ...(signal ? { signal } : {}) });
      const match = /^\s*MachineGuid\s+REG_SZ\s+([a-f0-9-]+)\s*$/imu.exec(result.stdout);
      if (!match?.[1] || !uuid.test(match[1])) throw new Error('MACHINE_ID');
      machine = match[1].toLowerCase();
    } else {
      machine = (await readFile('/etc/machine-id', { encoding: 'utf8', ...(signal ? { signal } : {}) })).trim();
      if (!/^[a-f0-9]{32}$/u.test(machine)) throw new Error('MACHINE_ID');
    }
    assertActive(signal);
    return { platform: platform === 'win32' ? 'win32' : 'linux',
      hostId: createHash('sha256').update(`${platform}\0${hostname()}\0${machine}`).digest('hex') };
  } catch { assertActive(signal); throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'HOST_OBSERVATION_UNKNOWN' }); }
}
