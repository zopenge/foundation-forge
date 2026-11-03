import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function putArtifactFile(path: string, text: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, text);
}
/** 两层 pnpm realpath 依赖和函数别名均由当前测试现场生成。 */
export async function linkedFunction(output: string): Promise<void> {
  const fn = resolve(output, 'functions/main.func'), modules = resolve(fn, 'node_modules');
  await putArtifactFile(resolve(fn, '.vc-config.json'), '{"runtime":"nodejs22.x","handler":"index.cjs","launcherType":"Nodejs"}');
  await putArtifactFile(resolve(fn, 'index.cjs'), 'module.exports=require("a")');
  for (const [name, body] of [['a', 'module.exports=require("b")'], ['b', 'module.exports=require("c")'], ['c', 'module.exports="closed-layout"']] as const) {
    const root = resolve(modules, `.pnpm/${name}@1.0.0/node_modules/${name}`);
    await putArtifactFile(resolve(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.cjs' }));
    await putArtifactFile(resolve(root, 'index.cjs'), body);
  }
  await symlink('.pnpm/a@1.0.0/node_modules/a', resolve(modules, 'a'), 'dir');
  await symlink('../../b@1.0.0/node_modules/b', resolve(modules, '.pnpm/a@1.0.0/node_modules/b'), 'dir');
  await symlink('../../c@1.0.0/node_modules/c', resolve(modules, '.pnpm/b@1.0.0/node_modules/c'), 'dir');
  await symlink('main.func', resolve(output, 'functions/alias.func'), 'dir');
}
