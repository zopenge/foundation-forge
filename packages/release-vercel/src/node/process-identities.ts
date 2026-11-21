import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { createPosixProcessControl, createPosixProcessIdentityReader, createWindowsProcessControl, createWindowsNativeProcessIdentityReader } from '@openge/forge-process-control-node';
import type { RecordedIdentity } from './managed-state-contracts.js';
import { assertActive, ReleaseError } from './errors.js';

export const processControl = () => process.platform === 'win32' ? createWindowsProcessControl({ listenerBackend: 'netstat', identityReader: identityReader() }) : createPosixProcessControl({ listenerBackend: 'lsof' });
export const identityReader = () => process.platform === 'win32' ? createWindowsNativeProcessIdentityReader() : createPosixProcessIdentityReader();

/** 保留精确 WMI 查询的原始记录，供恢复层检查行数和创建时间。 */
export async function queryWindowsCimIdentity(pid: number, signal: AbortSignal): Promise<unknown> {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32' || !systemRoot || !/^[a-z]:[\\/]/iu.test(systemRoot) || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff)
    throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'WINDOWS_CIM_IDENTITY' });
  const command = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop'; $rows = @(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=" + pid
    + "' -Property ProcessId,CreationDate | Select-Object ProcessId,CreationDate); ConvertTo-Json -InputObject $rows -Compress";
  const { stdout, stderr } = await promisify(execFile)(command, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 4096, signal });
  if (stderr.trim()) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'WINDOWS_CIM_IDENTITY' });
  return JSON.parse(stdout);
}
export async function currentCoordinator(signal?: AbortSignal): Promise<RecordedIdentity> {
  assertActive(signal);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const value = await identityReader().readIdentity({ pid: process.pid, signal: combined });
    assertActive(signal);
    if (value.status === 'FOUND' && value.identity.pid === process.pid && value.identity.startToken.length <= 128) return value.identity;
  } catch { assertActive(signal); }
  finally { clearTimeout(timer); }
  throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'COORDINATOR_IDENTITY' });
}
