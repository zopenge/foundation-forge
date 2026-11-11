import { resolve } from 'node:path';
import { ensureTestTemporaryDirectory } from '../../../scripts/test-temporary-directory.mjs';

// 优先归入当前Job的私有目录；独立包测试仍从仓库标准临时根现场创建。
export const sourceTestTemporaryDirectory = async (): Promise<string> => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  return ensureTestTemporaryDirectory(repositoryRoot,
    resolve(process.env.FORGE_CHECK_JOB_TEMP ?? resolve(repositoryRoot, 'tmp'), 'snapshots'));
};
