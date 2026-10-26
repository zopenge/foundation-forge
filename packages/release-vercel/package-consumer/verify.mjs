import { spawnSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
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
      sampleIntervalMs: 1000, install: { packageManager: 'pnpm' }, prepare: name === 'beta' ? [{ command: 'node', args: ['-e',
        'const f=require("node:fs"),p=require("node:path");const link=p.resolve("node_modules/pending"),target=p.resolve("node_modules/.pnpm/pending/node_modules/dependency");f.mkdirSync(p.dirname(link),{recursive:true});try{f.lstatSync(link)}catch(e){if(e.code!=="ENOENT")throw e;f.symlinkSync(target,link,"junction")}'
      ] }] : [] },
    git: { remote: 'origin', repository: remote, developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [{ command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify([process.env.FORGE_RELEASE_COMMAND,process.env.FORGE_RELEASE_SHA,process.cwd()]))'] }],
    acceptance: [{ command: 'node', args: ['-e', 'process.exit(0)'] }], buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 30000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } });
  await writeFile(resolve(cwd, '.gitignore'), '.tmp/\nnode_modules/\n');
  await writeFile(resolve(cwd, 'release.config.json'), JSON.stringify(config));
  const installOnce = 'const fs=require("node:fs");fs.mkdirSync("node_modules",{recursive:true});const p="node_modules/install-attempt";if(!fs.existsSync(p)){fs.writeFileSync(p,"failed once");process.exit(23)}';
  await writeFile(resolve(cwd, 'package.json'), JSON.stringify({ name: `consumer-${name}`, private: true, packageManager: `pnpm@${pnpmVersion}`,
    ...(name === 'beta' ? { scripts: { postinstall: `node -e ${JSON.stringify(installOnce)}` } } : {}) }));
  await writeFile(resolve(cwd, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(resolve(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
  await writeFile(resolve(cwd, 'source.txt'), 'initial\n'); git('add', '.'); git('commit', '-m', 'initial'); git('push', 'origin', 'HEAD:dev', 'HEAD:main');
  const initial = git('rev-parse', 'HEAD'); await writeFile(resolve(cwd, 'source.txt'), 'candidate\n'); git('add', '-u'); git('commit', '-m', 'candidate');
  const sha = git('rev-parse', 'HEAD'); await writeFile(resolve(cwd, 'user-note'), 'preserve');
  if (name === 'alpha') {
    git('config', 'core.autocrlf', 'true');
    await writeFile(resolve(cwd, '.git/info/attributes'), '.gitignore !text !eol\n');
    await unlink(resolve(cwd, '.gitignore')); git('checkout-index', '--force', '--', '.gitignore');
    // checkout-index 的旧 stat 缓存可报告无内容差异的 M；刷新匹配同一 blob 的索引后再冻结基线。
    git('add', '--', '.gitignore');
    if (git('diff', '--cached', '--', '.gitignore') !== '' || git('status', '--porcelain=v1', '--untracked-files=no') !== '') throw new Error('CRLF fixture baseline is not clean');
    if (!(await readFile(resolve(cwd, '.gitignore'), 'utf8')).includes('\r\n') || git('diff', 'HEAD', '--', '.gitignore') !== '') throw new Error('CRLF checkout fixture was not materialized');
  }
  let failed;
  if (name === 'beta') {
    failed = await runRelease({ command: 'check', cwd });
    if (failed.ok || failed.error?.code !== 'COMMAND_FAILED' || failed.stage !== 'install' || failed.processes?.status !== 'closed') throw new Error(`tarball failed-install closure mismatch: ${JSON.stringify(failed.error)}`);
  }
  // 两个独立消费者分别覆盖 Node 成功与 Node 失败后的 CLI 恢复，避免重复完整入口笛卡尔积。
  // Node 成功入口使用真实子进程，保留后续历史退役测试所需的已退出协调器事实。
  const lock = await readFile(resolve(failed?.executionRoot ?? cwd, 'pnpm-lock.yaml'));
  const first = JSON.parse(execute(cwd, process.execPath, name === 'alpha'
    ? [resolve(import.meta.dirname, 'node-check.mjs'), cwd]
    : [binaries['forge-vercel-release'], 'check', '--cwd', cwd]));
  if (!first.ok || first.candidateSha !== sha || first.processes?.status !== 'closed') throw new Error(`tarball managed check failed: ${JSON.stringify(first.error)}`);
  if (failed) {
    if (first.slotId !== failed.slotId || first.executionRoot !== failed.executionRoot) throw new Error('tarball retry changed its owned slot');
    const history = JSON.parse(await readFile(resolve(cwd, '.tmp/release-slot/history', `${failed.runId}.json`), 'utf8'));
    if (JSON.parse(history.snapshot.check).report.ok !== false || history.outcome?.error?.code !== 'COMMAND_FAILED') throw new Error('tarball retry lost its failed install outcome');
    if (await readFile(resolve(first.executionRoot, 'node_modules/install-attempt'), 'utf8') !== 'failed once') throw new Error('tarball retry lost its install cache');
  }
  const expected = ['check', sha, first.executionRoot];
  if (JSON.stringify(JSON.parse(first.steps.find(step => step.name === 'check:0')?.stdout ?? 'null')) !== JSON.stringify(expected)) throw new Error('tarball frozen command metadata mismatch');
  if (!(await readFile(resolve(first.executionRoot, 'pnpm-lock.yaml'))).equals(lock)) throw new Error('frozen lock changed');
  const sourceState = { branch: git('branch', '--show-current'), tracked: git('status', '--porcelain=v1', '--untracked-files=no'), note: await readFile(resolve(cwd, 'user-note'), 'utf8') };
  if (sourceState.branch !== 'dev' || sourceState.tracked !== '' || sourceState.note !== 'preserve') throw new Error(`source changed: ${JSON.stringify(sourceState)}`);
  for (const branch of ['dev', 'main']) if (execute(root, 'git', ['--git-dir', remote, 'rev-parse', branch]) !== initial) throw new Error('check changed remote refs');
  if (name === 'alpha') {
    const slot = resolve(cwd, '.tmp/release-slot'), statePath = resolve(slot, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (!/^[a-f0-9]{64}$/u.test(state.host?.hostId ?? '')) throw new Error('managed origin was not recorded');
    // 在自有 fixture 中构造旧格式的中断 journal；真实 check 子进程已经退出，不制造悬挂进程。
    delete state.host; delete state.history; state.schemaVersion = 2; state.status = 'unknown'; const interrupted = state.processes.at(-1);
    if (!interrupted) throw new Error('managed command evidence missing');
    delete interrupted.closure; delete interrupted.terminalSha256; interrupted.status = 'identified'; interrupted.observationComplete = false;
    await unlink(resolve(slot, 'terminal.json'));
    const original = JSON.stringify(state); await writeFile(statePath, original);
    const oldLock = JSON.stringify({ pid: state.coordinator.pid, identity: state.coordinator, runId: state.runId, token: randomUUID(), startedAt: new Date().toISOString() });
    await writeFile(resolve(slot, 'run.lock'), oldLock, { flag: 'wx' });
    const retirement = spawnSync(process.execPath, [binaries['forge-vercel-release'], 'retire', '--run-id', state.runId, '--cwd', cwd], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000 });
    const observation = JSON.parse(retirement.stdout || '{}');
    if (retirement.status !== 1 || observation.error?.details?.reason !== 'ORIGIN_CONFIRMATION_REQUIRED' || observation.retirement?.historicalVerification !== 'unknown') throw new Error(`tarball retirement failed: ${JSON.stringify(observation.error)}`);
    if (await readFile(statePath, 'utf8') !== original || await readFile(resolve(slot, 'run.lock'), 'utf8') !== oldLock) throw new Error('retirement changed unconfirmed historical evidence');
  }
}
