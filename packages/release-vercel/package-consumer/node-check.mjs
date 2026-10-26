import process from 'node:process';
import { runRelease } from '@openge/forge-release-vercel/node';

const [cwd] = process.argv.slice(2);
const report = await runRelease({ command: 'check', cwd });
process.stdout.write(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1;
