import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const [mode, root] = process.argv.slice(2);
const release = (name, done) => {
  const file = join(root, name);
  const watcher = watch(root, () => { if (existsSync(file)) { watcher.close(); done(); } });
  if (existsSync(file)) { watcher.close(); done(); }
};
if (mode === 'descendant') {
  release('child-exit', () => process.exit(0));
  process.on('disconnect', () => {});
  process.send({ pid: process.pid });
} else if (mode === 'parent') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', root],
    { windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.once('message', ({ pid }) => {
    release('parent-exit', () => { child.disconnect(); child.unref(); process.exit(0); });
    process.stdout.write(`${JSON.stringify({ pid })}\n`);
  });
} else throw new Error('INVALID_FIXTURE_MODE');
