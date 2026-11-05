import { availableParallelism, freemem } from 'node:os';
import { statfs } from 'node:fs/promises';

export const readFastCheckResources = async repositoryRoot => {
  const volume = await statfs(repositoryRoot, { bigint: true });
  return { cpus: availableParallelism(), freeMemory: freemem(), freeDisk: volume.bavail * volume.bsize };
};

/** 只修改本次协调器的任务配置；资源失败和冲突参数不能启动构建。 */
export async function resolveCheckOptions(args, { env, resources }) {
  if (new Set(args).size !== args.length || args.some(arg => !['--quick', '--full', '--serial', '--fast'].includes(arg))
    || args.includes('--quick') && args.includes('--full') || args.includes('--serial') && !args.includes('--full')
    || args.includes('--fast') && (!args.includes('--full') || args.includes('--serial')))
    throw new Error('CHECK_ARGUMENT_INVALID');
  if (args.includes('--fast')) {
    if (env.FORGE_CHECK_TEST_WORKERS !== undefined && env.FORGE_CHECK_TEST_WORKERS !== '8') throw new Error('FAST_CHECK_BUDGET_CONFLICT');
    const value = await resources();
    if (!Number.isSafeInteger(value.cpus) || value.cpus < 8 || !Number.isFinite(value.freeMemory)
      || value.freeMemory < 12 * 2 ** 30 || typeof value.freeDisk !== 'bigint' || value.freeDisk < 20n * 1024n ** 3n)
      throw new Error('FAST_CHECK_RESOURCES');
    env.FORGE_CHECK_TEST_WORKERS = '8';
  }
  if (args.includes('--serial')) env.FORGE_CHECK_TEST_WORKERS = '1';
  return { quick: args.includes('--quick'), full: args.includes('--full') };
}
