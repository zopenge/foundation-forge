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
}
