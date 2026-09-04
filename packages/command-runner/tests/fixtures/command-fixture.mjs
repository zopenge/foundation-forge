import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'output') {
  process.stdout.write('alpha');
  process.stdout.write(' β');
  process.stderr.write('error');
  process.exitCode = Number(args[0] ?? 0);
} else if (mode === 'inspect') {
  process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
} else if (mode === 'bytes') {
  process.stdout.write('你好吗');
  process.stderr.write('abcdef');
} else if (mode === 'wait') {
  setInterval(() => {}, 1000);
} else if (mode === 'delay') {
  setTimeout(() => process.stdout.write('done'), Number(args[0]));
} else if (mode === 'hold-pipe') {
  const descendant = spawn(process.execPath, [process.argv[1], 'hold-pipe-child', args[0]], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });
  descendant.once('error', error => process.stderr.write(JSON.stringify({ stage: 'descendant-start', code: error.code }) + '\n'));
  descendant.once('exit', (code, signal) => { if (code !== 0) process.stderr.write(JSON.stringify({ stage: 'descendant-exit', code, signal }) + '\n'); });
  setTimeout(() => descendant.unref(), 150);
} else if (mode === 'hold-pipe-child') {
  process.on('exit', () => writeFileSync(args[0], 'cleaned', 'utf8'));
  setTimeout(() => process.exit(0), 1200);
}
