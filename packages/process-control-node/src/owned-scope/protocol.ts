import { ProcessControlError, processControlErrorCodes, type OwnedProcessLaunchRequest } from '@openge/forge-process-control';

export const controlLimit = 65_536, launchLimit = 1_048_576;
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function validateLaunch(value: unknown): asserts value is OwnedProcessLaunchRequest {
  const request = object(value);
  const text = (value: unknown) => typeof value === 'string' && !value.includes('\0');
  const args = request.args ?? [], environment = object(request.environment);
  if (typeof request.command !== 'string' || !text(request.command) || request.command.length === 0 || (request.cwd !== undefined && !text(request.cwd))
    || !Array.isArray(args) || !args.every(text) || typeof request.binding !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(request.binding)
    || ![request.startupTimeoutMs, request.terminationTimeoutMs].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)
    || request.environment === null || typeof request.environment !== 'object' || Array.isArray(request.environment)
    || Object.entries(environment).some(([key, value]) => !text(key) || key.includes('=') || (value !== undefined && !text(value)))
    || Buffer.byteLength(JSON.stringify(request)) > launchLimit - 4096) throw new ProcessControlError(processControlErrorCodes.scopeInvalidInput);
}
export interface ScopeKey { readonly scopeId: string; readonly binding: string; readonly nonce: string }
export interface ScopeFrame extends ScopeKey { readonly version: 1; readonly sequence: number; readonly type: string; readonly id?: number; readonly payload?: unknown }
export function frame(key: ScopeKey, sequence: number, type: string, payload?: unknown, id?: number): ScopeFrame {
  return { ...key, version: 1, sequence, type, ...(payload === undefined ? {} : { payload }), ...(id === undefined ? {} : { id }) };
}
export function readFrame(value: unknown, key: ScopeKey, sequence: number): ScopeFrame {
  const item = object(value);
  if (item.version !== 1 || item.scopeId !== key.scopeId || item.binding !== key.binding || item.nonce !== key.nonce || item.sequence !== sequence
    || typeof item.type !== 'string' || (item.id !== undefined && (!Number.isSafeInteger(item.id) || Number(item.id) < 1))
    || Buffer.byteLength(JSON.stringify(value)) > (item.type === 'start' ? launchLimit : controlLimit)) throw new ProcessControlError(processControlErrorCodes.scopeBinding, { reason: 'PROTOCOL' });
  return frame(key, sequence, item.type, item.payload, typeof item.id === 'number' ? item.id : undefined);
}
export function supervisorEnvironment(environment: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_AUDIT'].includes(key.toUpperCase()) && !key.toUpperCase().startsWith('DYLD_')));
}
