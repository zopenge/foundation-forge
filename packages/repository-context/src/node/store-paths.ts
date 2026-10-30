import { lstat } from 'node:fs/promises';
import { parse, resolve, sep } from 'node:path';

export const assertGenerationId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(value)) {
    throw Object.assign(new Error('unsafe generation id'), { code: 'UNSAFE_PATH' });
  }
  return value;
};

// 不跟随目录链中的链接；缺失路径由后续创建或读取操作处理。
export const assertStorePath = async (path: string, directory = false): Promise<void> => {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const components = absolute.slice(current.length).split(sep).filter(Boolean);
  for (const component of components) {
    current = resolve(current, component);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || ((current !== absolute || directory) ? !metadata.isDirectory() : !metadata.isFile())) {
      throw Object.assign(new Error('unsafe repository store path'), { code: 'UNSAFE_PATH' });
    }
  }
};
