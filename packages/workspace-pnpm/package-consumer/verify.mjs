import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import { readPnpmWorkspace } from '@openge/forge-workspace-pnpm';

await writeFile('pnpm-workspace.yaml', 'packages: []\n', 'utf8');
if ((await readPnpmWorkspace({ cwd: process.cwd() })).packages.length !== 0) {
  throw new Error('pnpm workspace consumer smoke failed');
}
