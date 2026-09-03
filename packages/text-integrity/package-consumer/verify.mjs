import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import { inspectTextIntegrity } from '@openge/forge-text-integrity';

if (inspectTextIntegrity('broken ???').length !== 1) { // check-mojibake-ignore-line
  throw new Error('text integrity consumer smoke failed');
}
const git = spawnSync('git', ['init', '--quiet'], { encoding: 'utf8', shell: false });
if (git.status !== 0) throw new Error(git.stderr || 'git consumer fixture failed');
await writeFile('fixture.ts', 'broken ???\n', 'utf8'); // check-mojibake-ignore-line
const binaries = JSON.parse(process.env.PACKAGE_CONSUMER_BINARIES ?? '{}');
const result = spawnSync(process.execPath, [binaries['forge-text-integrity'], 'fixture.ts'], {
  encoding: 'utf8',
  shell: false,
});
if (result.status !== 1 || !result.stderr.includes('question-placeholder')) {
  throw new Error([
    'text integrity CLI consumer smoke failed',
    `status: ${String(result.status)}`,
    `error: ${String(result.error ?? '')}`,
    `stdout: ${result.stdout}`,
    `stderr: ${result.stderr}`,
  ].join('\n'));
}
