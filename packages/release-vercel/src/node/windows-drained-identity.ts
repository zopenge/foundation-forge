import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';
import type { RecordedIdentity } from './managed-state-contracts.js';
import { queryWindowsCimIdentity } from './process-identities.js';
import { record } from './errors.js';

function creationTime(token: unknown): number | undefined {
  if (typeof token !== 'string') return;
  const match = /^\/Date\(([1-9]\d{0,15})\)\/$/u.exec(token);
  if (!match) return;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** 原生句柄访问失败后，只接受同一 PID 的独立创建时间证明。 */
export async function observeWindowsPidReplacement(original: RecordedIdentity, failure: unknown, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'win32' || signal.aborted || !(failure instanceof ProcessControlError)
    || failure.code !== processControlErrorCodes.commandFailed || failure.details.backend !== 'windows-native'
    || failure.details.stage !== 'OPEN_PROCESS' || failure.details.nativeCode !== 5) return false;
  const previous = creationTime(original.startToken);
  if (previous === undefined) return false;
  try {
    const current = await queryWindowsCimIdentity(original.pid, signal);
    if (signal.aborted || !Array.isArray(current) || current.length !== 1) return false;
    const identity = record(current[0]);
    if (identity.ProcessId !== original.pid) return false;
    const created = creationTime(identity.CreationDate);
    return created !== undefined && created > previous;
  } catch { return false; }
}
