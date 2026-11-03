import { mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const output = resolve('.vercel/output'), fn = resolve(output, 'functions/main.func'), modules = resolve(fn, 'node_modules');
await rm(output, { recursive: true, force: true });
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
await put(resolve(output, 'config.json'), '{"version":3}');
await put(resolve(output, 'static/index.html'), 'self-contained public consumer');
await put(resolve(fn, '.vc-config.json'), '{"runtime":"nodejs22.x","handler":"index.cjs","launcherType":"Nodejs"}');
await put(resolve(fn, 'index.cjs'), 'module.exports=require("a")');
for (const [name, value] of [['a', 'module.exports=require("b")'], ['b', 'module.exports=require("c")'], ['c', 'module.exports="public-tarball-layout"']]) {
  const root = resolve(modules, `.pnpm/${name}@1.0.0/node_modules/${name}`);
  await put(resolve(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.cjs' })); await put(resolve(root, 'index.cjs'), value);
}
await symlink('.pnpm/a@1.0.0/node_modules/a', resolve(modules, 'a'), 'dir');
await symlink('../../b@1.0.0/node_modules/b', resolve(modules, '.pnpm/a@1.0.0/node_modules/b'), 'dir');
await symlink('../../c@1.0.0/node_modules/c', resolve(modules, '.pnpm/b@1.0.0/node_modules/c'), 'dir');
await symlink('main.func', resolve(output, 'functions/alias.func'), 'dir');
process.stdout.write(JSON.stringify({ url: process.env.FORGE_RELEASE_VERSION_URL, config: process.env.FORGE_RELEASE_CONFIG_SHA256,
  context: process.env.FORGE_RELEASE_CANDIDATE_CONTEXT }));
