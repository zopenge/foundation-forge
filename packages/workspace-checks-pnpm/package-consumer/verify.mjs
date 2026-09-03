import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { checkPnpmWorkspace } from '@openge/forge-workspace-checks-pnpm';

const createPackage = async (root, name, dependencies = undefined) => {
  const path = resolve(root, 'packages', name);
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, 'package.json'), JSON.stringify({ dependencies, name }), 'utf8');
};
const clean = resolve('clean');
await mkdir(clean, { recursive: true });
await writeFile(resolve(clean, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf8');
await createPackage(clean, 'a');
if (!(await checkPnpmWorkspace({ cwd: clean })).passed) {
  throw new Error('workspace checks clean consumer smoke failed');
}

const cycle = resolve('cycle');
await mkdir(cycle, { recursive: true });
await writeFile(resolve(cycle, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf8');
await createPackage(cycle, 'a', { b: 'workspace:*' });
await createPackage(cycle, 'b', { a: 'workspace:*' });
const binaries = JSON.parse(process.env.PACKAGE_CONSUMER_BINARIES ?? '{}');
const result = spawnSync(process.execPath, [
  binaries['forge-workspace-checks'],
  '--cwd',
  cycle,
  '--check',
  'package-cycles',
], { encoding: 'utf8', shell: false });
if (result.status !== 1 || result.stdout.length !== 0 || !result.stderr.includes('a -> b -> a')) {
  throw new Error('workspace checks cycle CLI consumer smoke failed');
}
