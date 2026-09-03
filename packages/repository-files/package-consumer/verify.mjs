import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import { listRepositoryFiles } from '@openge/forge-repository-files';

const runGit = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || 'git consumer fixture failed');
};
runGit(['init', '--quiet']);
await writeFile('.gitignore', 'node_modules/\n', 'utf8');
await writeFile('fixture.ts', 'export {};\n', 'utf8');
runGit(['add', '.gitignore', 'fixture.ts']);
if (!(await listRepositoryFiles({ cwd: process.cwd() })).includes('fixture.ts')) {
  throw new Error('repository discovery consumer smoke failed');
}
