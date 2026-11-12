import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertActive, ReleaseError } from './errors.js';
import { assertPathChain } from './managed-io.js';

/** umask 仅服务部署归档；CLI 配置和缓存隔离在自有目录，不能在宽掩码下创建用户级文件。 */
export async function createPrebuiltCliContext(cwd: string, teamId: string, signal?: AbortSignal) {
  assertActive(signal);
  const parent = resolve(cwd, 'tmp/forge-vercel-release');
  await assertPathChain(cwd, parent); assertActive(signal);
  await mkdir(parent, { recursive: true });
  await assertPathChain(cwd, parent); assertActive(signal);
  const directory = await mkdtemp(resolve(parent, 'cli-')), identity = await lstat(directory, { bigint: true });
  const dispose = async () => {
    await assertPathChain(cwd, directory);
    const current = await lstat(directory, { bigint: true });
    if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isDirectory() || current.isSymbolicLink()) throw new ReleaseError('SLOT_PATH');
    await rm(directory, { recursive: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    assertActive(signal);
    await writeFile(resolve(directory, 'config.json'), JSON.stringify({ currentTeam: teamId }), { flag: 'wx', mode: 0o600 });
    assertActive(signal);
    return { directory, environment: { XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, APPDATA: directory, LOCALAPPDATA: directory,
      DO_NOT_TRACK: '1', NO_UPDATE_NOTIFIER: '1' }, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'CLI_CONTEXT_CLEANUP', { cause: cleanup }); }
    throw error;
  }
}
