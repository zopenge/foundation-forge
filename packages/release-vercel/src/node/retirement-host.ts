import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { promisify } from 'node:util';
import { assertActive, record, ReleaseError } from './errors.js';

export interface RetirementHost {
  readonly platform: 'win32' | 'linux';
  readonly hostId: string;
  readonly uptimeSeconds: number;
  readonly bootId?: string;
}
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export function validRetirementHost(value: unknown): value is RetirementHost {
  const item = record(value);
  return ['win32', 'linux'].includes(String(item.platform)) && typeof item.hostId === 'string' && /^[a-f0-9]{64}$/u.test(item.hostId)
    && typeof item.uptimeSeconds === 'number' && Number.isFinite(item.uptimeSeconds) && item.uptimeSeconds >= 0
    && (item.platform === 'linux' ? typeof item.bootId === 'string' && uuid.test(item.bootId) : item.bootId === undefined);
}
export async function readRetirementHost(signal?: AbortSignal): Promise<RetirementHost> {
  assertActive(signal);
  const platform = process.platform;
  if (!['win32', 'linux'].includes(platform)) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_HOST' });
  try {
    const before = uptime(); let machine: string, bootId: string | undefined;
    if (platform === 'win32') {
      const result = await promisify(execFile)('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4096, ...(signal ? { signal } : {}) });
      const match = /^\s*MachineGuid\s+REG_SZ\s+([a-f0-9-]+)\s*$/imu.exec(result.stdout);
      if (!match?.[1] || !uuid.test(match[1])) throw new Error('MACHINE_ID');
      machine = match[1].toLowerCase();
    } else {
      machine = (await readFile('/etc/machine-id', { encoding: 'utf8', ...(signal ? { signal } : {}) })).trim();
      bootId = (await readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', ...(signal ? { signal } : {}) })).trim();
      if (!/^[a-f0-9]{32}$/u.test(machine)) throw new Error('MACHINE_ID');
    }
    assertActive(signal);
    const after = uptime();
    const observation: RetirementHost = { platform: platform === 'win32' ? 'win32' : 'linux',
      hostId: createHash('sha256').update(`${platform}\0${hostname()}\0${machine}`).digest('hex'), uptimeSeconds: before,
      ...(bootId ? { bootId } : {}) };
    if (after < before || !validRetirementHost(observation)) throw new Error('BOOT_OBSERVATION');
    return observation;
  } catch { assertActive(signal); throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'HOST_OBSERVATION_UNKNOWN' }); }
}
/** 这里只证明新的宿主开机周期，不证明历史命令正常退出。Windows 计数器含睡眠时间且不依赖墙钟。 */
export function hasSubsequentBoot(before: RetirementHost, after: RetirementHost): boolean {
  if (!validRetirementHost(before) || !validRetirementHost(after) || before.platform !== after.platform || before.hostId !== after.hostId) return false;
  return before.platform === 'linux' ? before.bootId !== after.bootId : before.uptimeSeconds - after.uptimeSeconds >= 60;
}
