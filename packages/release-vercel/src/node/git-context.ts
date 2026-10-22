import { ReleaseError } from './errors.js';

const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_NAMESPACE'] as const;
export const isolatedGitEnvironment = (): Readonly<Record<string, undefined>> => Object.fromEntries(names.map(name => [name, undefined]));
export function assertNoGitContext(): void {
  const active = Object.keys(process.env).filter(key => names.some(name => (process.platform === 'win32' ? key.toUpperCase() : key) === name) && process.env[key]);
  if (active.length > 0) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'GIT_CONTEXT_ENV', names: active.map(name => name.toUpperCase()) });
}
