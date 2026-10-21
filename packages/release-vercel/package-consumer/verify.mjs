import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { releaseErrorCodes } from '@openge/forge-release-vercel';
import { runRelease, validateReleaseConfig } from '@openge/forge-release-vercel/node';

if (!releaseErrorCodes.includes('CANDIDATE_CHANGED') || typeof runRelease !== 'function') throw new Error('release contracts missing');
try { validateReleaseConfig({ schemaVersion: 9 }); throw new Error('invalid config accepted'); }
catch (error) { if (error.code !== 'CONFIG_INVALID') throw error; }
const binaries = JSON.parse(process.env.PACKAGE_CONSUMER_BINARIES ?? '{}');
const result = spawnSync(process.execPath, [binaries['forge-vercel-release'], 'publish', '--sha', 'bad'], { encoding: 'utf8', shell: false });
if (result.status !== 2 || JSON.parse(result.stdout).error.code !== 'ARGUMENT_INVALID') throw new Error('release CLI consumer contract failed');
const report = await runRelease({ command: 'check', cwd: process.cwd(), configPath: 'absent-config.json' });
if (report.ok || report.error?.code !== 'CONFIG_READ') throw new Error('release Node consumer contract failed');
