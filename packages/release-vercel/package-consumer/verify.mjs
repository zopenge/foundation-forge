import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

// 两个独立 Git 输入根消费已安装 tarball，只经过公开 Node/CLI 入口。
const execute = (cwd, command, args) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 600_000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
const manager = process.env.npm_execpath;
if (!manager) throw new Error('consumer verification requires the invoking pnpm CLI path');
const pnpmVersion = execute(process.cwd(), process.execPath, [manager, '--version']);
if (!/^\d+\.\d+\.\d+$/u.test(pnpmVersion)) throw new Error('consumer pnpm version unavailable');
const base = resolve(process.cwd(), '.tmp/managed-consumers'); await mkdir(base, { recursive: true });
for (const name of ['alpha', 'beta']) {
  const root = resolve(base, name), cwd = resolve(root, 'source with spaces'), remote = resolve(root, 'remote.git');
  await mkdir(root, { recursive: true });
  execute(root, 'git', ['init', '--bare', remote]); execute(root, 'git', ['init', '-b', 'dev', cwd]);
  const git = (...args) => execute(cwd, 'git', args);
  git('config', 'user.name', 'Consumer'); git('config', 'user.email', 'consumer@example.invalid'); git('remote', 'add', 'origin', remote);
  const config = validateReleaseConfig({ schemaVersion: 2,
    source: { mode: 'managed-commit', slotPath: '.tmp/release-slot', maxBytes: 2147483648, minFreeBytes: 5368709120,
      sampleIntervalMs: 1000, install: { packageManager: 'pnpm' }, prepare: [] },
    git: { remote: 'origin', repository: remote, developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [{ command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify([process.env.FORGE_RELEASE_COMMAND,process.env.FORGE_RELEASE_SHA,process.cwd()]))'] }],
    acceptance: [{ command: 'node', args: ['-e', 'process.exit(0)'] }], buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 30000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } });
  await writeFile(resolve(cwd, '.gitignore'), '.tmp/\nnode_modules/\n');
  await writeFile(resolve(cwd, 'release.config.json'), JSON.stringify(config));
  await writeFile(resolve(cwd, 'package.json'), JSON.stringify({ name: `consumer-${name}`, private: true, packageManager: `pnpm@${pnpmVersion}` }));
  await writeFile(resolve(cwd, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(resolve(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
  await writeFile(resolve(cwd, 'source.txt'), 'initial\n'); git('add', '.'); git('commit', '-m', 'initial'); git('push', 'origin', 'HEAD:dev', 'HEAD:main');
  const initial = git('rev-parse', 'HEAD'); await writeFile(resolve(cwd, 'source.txt'), 'candidate\n'); git('add', '-u'); git('commit', '-m', 'candidate');
  const sha = git('rev-parse', 'HEAD'); await writeFile(resolve(cwd, 'user-note'), 'preserve');
  const first = await runRelease({ command: 'check', cwd });
  if (!first.ok || first.candidateSha !== sha) throw new Error(`tarball managed check failed: ${JSON.stringify(first.error)}`);
  const expected = ['check', sha, first.executionRoot];
  if (JSON.stringify(JSON.parse(first.steps.find(step => step.name === 'check:0')?.stdout ?? 'null')) !== JSON.stringify(expected)) throw new Error('tarball frozen command metadata mismatch');
  const lock = await readFile(resolve(first.executionRoot, 'pnpm-lock.yaml'));
  const second = JSON.parse(execute(cwd, process.execPath, [binaries['forge-vercel-release'], 'check', '--cwd', cwd]));
  if (!second.ok || second.slotId !== first.slotId || second.executionRoot !== first.executionRoot) throw new Error(`tarball CLI reuse failed: ${JSON.stringify(second.error)}`);
  if (!(await readFile(resolve(first.executionRoot, 'pnpm-lock.yaml'))).equals(lock)) throw new Error('frozen lock changed');
  if (git('branch', '--show-current') !== 'dev' || git('status', '--porcelain=v1', '--untracked-files=no') !== '' || await readFile(resolve(cwd, 'user-note'), 'utf8') !== 'preserve') throw new Error('source changed');
  for (const branch of ['dev', 'main']) if (execute(root, 'git', ['--git-dir', remote, 'rev-parse', branch]) !== initial) throw new Error('check changed remote refs');
}
