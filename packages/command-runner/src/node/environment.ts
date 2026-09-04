import process from 'node:process';
import type { CommandEnvironment } from '../contracts.js';

export function createEnvironment(environment: CommandEnvironment, platform: 'win32' | 'posix'): Record<string, string | undefined> {
  const result = new Map(Object.entries(environment.mode === 'inherit' ? process.env : {}));
  for (const [key, value] of Object.entries(environment.values ?? {})) {
    if (platform === 'win32') {
      for (const oldKey of result.keys()) if (oldKey.toLowerCase() === key.toLowerCase()) result.delete(oldKey);
    }
    if (value !== undefined) result.set(key, value);
    else result.delete(key);
  }
  return Object.fromEntries(result);
}
