import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// 仅创建仓库 .tmp 内的普通目录；先拒绝重解析祖先，不能把解析后的外部目录当信任根。
export const ensureTestTemporaryDirectory = async (repositoryRoot, target, io = { lstat, mkdir, realpath }) => {
  const inside = relative(resolve(repositoryRoot), resolve(target)), parts = inside.split(sep);
  if (!inside || isAbsolute(inside) || parts[0] !== '.tmp' || parts.includes('..'))
    throw new Error('test temporary directory must be under repository .tmp');
  const canonicalRepository = await io.realpath(repositoryRoot);
  let path = resolve(repositoryRoot);
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    let identity;
    try { identity = await io.lstat(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!identity) {
      try { await io.mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      identity = await io.lstat(path);
    }
    if (identity.isSymbolicLink() || !identity.isDirectory())
      throw new Error('test temporary ancestor is not a plain directory');
    if (await io.realpath(path) !== resolve(canonicalRepository, ...parts.slice(0, index + 1)))
      throw new Error('test temporary ancestor changed its canonical location');
  }
  return resolve(canonicalRepository, ...parts);
};
