import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { releaseErrorCodes } from '@openge/forge-release-vercel';
import { runRelease, validateReleaseConfig } from '@openge/forge-release-vercel/node';
import { verifyCompletionConsumer } from './completion-consumer.mjs';
import { verifyNotStartedConsumer } from './not-started-consumer.mjs';

if (!releaseErrorCodes.includes('CANDIDATE_CHANGED') || !releaseErrorCodes.includes('ARTIFACT_CHANGED')
  || !releaseErrorCodes.includes('VERSION_ALIAS_CONFLICT') || typeof runRelease !== 'function') throw new Error('release contracts missing');
try { validateReleaseConfig({ schemaVersion: 9 }); throw new Error('invalid config accepted'); }
catch (error) { if (error.code !== 'CONFIG_INVALID') throw error; }
const binaries = JSON.parse(process.env.PACKAGE_CONSUMER_BINARIES ?? '{}');
const result = spawnSync(process.execPath, [binaries['forge-vercel-release'], 'publish', '--sha', 'bad'], { encoding: 'utf8', shell: false, windowsHide: true });
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
  const managedSource = { mode: 'managed-commit', slotPath: '.tmp/release-slot', maxBytes: 2147483648, minFreeBytes: 5368709120,
      sampleIntervalMs: 1000, install: { packageManager: 'pnpm' }, prepare: [{ command: 'node', args: ['-e',
        'const f=require("node:fs"),p=require("node:path");const link=p.resolve("node_modules/pending"),target=p.resolve("node_modules/.pnpm/pending/node_modules/dependency");f.mkdirSync(p.dirname(link),{recursive:true});try{f.lstatSync(link)}catch(e){if(e.code!=="ENOENT")throw e;f.symlinkSync(target,link,"junction")}'
      ] }] };
  const config = validateReleaseConfig({ schemaVersion: 2, source: name === 'alpha'
    ? { ...managedSource, prepare: [...managedSource.prepare, { command: 'node', args: ['linked-output.mjs'] }] } : { mode: 'workspace' },
    ...(name === 'alpha' ? { delivery: { mode: 'prebuilt', maxFiles: 100, maxBytes: 1_048_576,
      versionAlias: { hostnameTemplate: `consumer-${name}-{sha}.vercel.app` },
      concurrencyControl: { mode: 'external-serialization', scope: `consumer-${name}` },
      admission: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] } } : {}),
    git: { remote: 'origin', repository: remote, developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [{ command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify([process.env.FORGE_RELEASE_COMMAND,process.env.FORGE_RELEASE_SHA,process.cwd()]))'] }],
    acceptance: [{ command: 'node', args: ['-e', 'process.exit(0)'] }], buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 30000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } });
  await writeFile(resolve(cwd, '.gitignore'), `.tmp/\nnode_modules/\n.vercel/\n${name === 'beta' ? 'user-note\n' : ''}`);
  await writeFile(resolve(cwd, 'release.config.json'), JSON.stringify(config));
  if (name === 'alpha') await copyFile(resolve(import.meta.dirname, 'linked-output.mjs'), resolve(cwd, 'linked-output.mjs'));
  await writeFile(resolve(cwd, 'package.json'), JSON.stringify({ name: `consumer-${name}`, private: true, packageManager: `pnpm@${pnpmVersion}`,
    ...(name === 'alpha' ? { scripts: { postinstall: 'node install-journal.mjs' } } : {}) }));
  if (name === 'alpha') await copyFile(resolve(import.meta.dirname, 'install-journal.mjs'), resolve(cwd, 'install-journal.mjs'));
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
  // alpha的同一次公开managed prebuilt检查覆盖CRLF、junction、构建与可移植制品；beta验证CLI workspace。
  // completion的公开publish/CLI retry保留另一条真实准备链，安装失败/同槽重试另由managed-resume承担。
  const lock = await readFile(resolve(cwd, 'pnpm-lock.yaml'));
  const first = JSON.parse(execute(cwd, process.execPath, name === 'alpha'
    ? [resolve(import.meta.dirname, 'node-check.mjs'), cwd]
    : [binaries['forge-vercel-release'], 'check', '--cwd', cwd]));
  if (!first.ok || first.candidateSha !== sha || name === 'alpha' && first.processes?.status !== 'closed') throw new Error(`tarball check failed: ${JSON.stringify(first.error)}`);
  const executionRoot = first.executionRoot ?? cwd;
  const expected = ['check', sha, executionRoot];
  if (JSON.stringify(JSON.parse(first.steps.find(step => step.name === 'check:0')?.stdout ?? 'null')) !== JSON.stringify(expected)) throw new Error('tarball frozen command metadata mismatch');
  if (!(await readFile(resolve(executionRoot, 'pnpm-lock.yaml'))).equals(lock)) throw new Error('frozen lock changed');
  if (name === 'alpha') {
    const before = await readFile(resolve(cwd, '.tmp/release-slot/state.json'));
    const installs = JSON.parse(before.toString('utf8')).processes.filter(command => command.name === 'install');
    const install = installs[0], steps = first.steps.filter(step => step.name === 'install');
    const closure = install?.closure?.ownedScope;
    // pnpm 会给真实生命周期输出加固定前缀；命令回显不满足这两种完整行。
    const marker = steps[0]?.stdout.split(/\r?\n/u).some(line => line === 'INSTALL_JOURNAL_VERIFIED'
      || line === '. postinstall: INSTALL_JOURNAL_VERIFIED');
    if (installs.length !== 1 || steps.length !== 1 || !marker
      || install?.status !== 'closed' || install.kind !== undefined || install.observationComplete !== true
      || !/^[a-f0-9]{64}$/u.test(install.terminalSha256 ?? '')
      || !install.identity?.pid || !install.identity.startToken || !install.scope?.scopeId || !install.scope.binding
      || install.closure?.exitCode !== 0 || install.closure.termination !== 'exit'
      || closure?.status !== 'closed' || closure.reason !== 'normal' || closure.empty !== true
      || closure.scopeId !== install.scope.scopeId || closure.binding !== install.scope.binding
      || closure.rootIdentity?.pid !== install.identity.pid || closure.rootIdentity.startToken !== install.identity.startToken)
      throw new Error(`tarball pnpm install identity journal was not verified before execution and after closure: ${JSON.stringify({
        installCount: installs.length, stepCount: steps.length, stdout: steps[0]?.stdout, install })}`);
    const recovered = JSON.parse(execute(cwd, process.execPath, [binaries['forge-vercel-release'], 'recover', '--cwd', cwd]));
    if (!recovered.ok || recovered.command !== 'recover' || recovered.candidateSha !== sha
      || recovered.processes?.status !== 'closed' || recovered.steps.some(step => step.name === 'install' || step.name.startsWith('check:')))
      throw new Error(`tarball managed CLI recovery failed: ${JSON.stringify(recovered.error)}`);
    if (!(await readFile(resolve(cwd, '.tmp/release-slot/state.json'))).equals(before)) throw new Error('CLI recovery changed stopped history');
    await verifyNotStartedConsumer({ cwd, binary: binaries['forge-vercel-release'], sha, execute });
  }
  const sourceState = { branch: git('branch', '--show-current'), tracked: git('status', '--porcelain=v1', '--untracked-files=no'), note: await readFile(resolve(cwd, 'user-note'), 'utf8') };
  if (sourceState.branch !== 'dev' || sourceState.tracked !== '' || sourceState.note !== 'preserve') throw new Error(`source changed: ${JSON.stringify(sourceState)}`);
  for (const branch of ['dev', 'main']) if (execute(root, 'git', ['--git-dir', remote, 'rev-parse', branch]) !== initial) throw new Error('check changed remote refs');
  if (name === 'alpha') {
    const state = JSON.parse(await readFile(resolve(cwd, '.tmp/release-slot/state.json'), 'utf8'));
    if (state.schemaVersion !== 3 || !/^[a-f0-9]{64}$/u.test(state.host?.hostId ?? '')) throw new Error('current managed origin was not recorded');
  } else {
    // 真实CLI仍经过managed选择和来源准入；外来slot必须在安装/执行之前被拒绝。
    config.source = managedSource; await writeFile(resolve(cwd, 'release.config.json'), JSON.stringify(config));
    git('add', '-u'); git('commit', '-m', 'managed admission');
    const rejectedSha = git('rev-parse', 'HEAD'), foreign = resolve(cwd, '.tmp/release-slot'); await mkdir(foreign, { recursive: true });
    const rejected = spawnSync(process.execPath, [binaries['forge-vercel-release'], 'check', '--cwd', cwd],
      { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 600_000 });
    const failure = JSON.parse(rejected.stdout);
    if (rejected.status !== 1 || failure.ok || failure.candidateSha !== rejectedSha || failure.error?.code !== 'SLOT_FOREIGN'
      || failure.steps.some(step => step.name === 'install' || step.name.startsWith('check:')) || (await readdir(foreign)).length)
      throw new Error(`tarball managed CLI admission failed: ${JSON.stringify(failure.error)}`);
    if (git('status', '--porcelain=v1', '--untracked-files=no') !== '' || await readFile(resolve(cwd, 'user-note'), 'utf8') !== 'preserve') throw new Error('rejected CLI changed source');
    for (const branch of ['dev', 'main']) if (execute(root, 'git', ['--git-dir', remote, 'rev-parse', branch]) !== initial) throw new Error('rejected CLI changed refs');
    // 此空目录由本fixture刚创建；仅删除已证明为空的自有目录。
    await rmdir(foreign);
  }
  if (name === 'alpha') {
  const prebuilt = config, prebuiltSha = sha, checked = first;
  if (!checked.ok || checked.candidateSha !== prebuiltSha || checked.prebuilt?.sourceSha !== prebuiltSha
    || checked.prebuilt?.fileCount !== 14 || !/^[a-f0-9]{64}$/u.test(checked.prebuilt?.artifactSha256 ?? '')
    || checked.prebuilt?.createEffect !== 'not-attempted' || checked.prebuilt?.promoteEffect !== 'not-attempted'
    || checked.processes?.status !== 'closed') throw new Error(`public tarball prebuilt check failed: ${JSON.stringify(checked.error)}`);
  const hostname = `consumer-${name}-${prebuiltSha}.vercel.app`;
  const metadata = JSON.parse(checked.steps.find(step => step.name === 'prepare:1')?.stdout ?? 'null');
  if (metadata?.url !== `https://${hostname}` || metadata.config !== checked.configSha256 || metadata.context !== ''
    || checked.candidateContext !== undefined || checked.effects.versionAliasAssign !== 'not-attempted'
    || JSON.stringify(checked.prebuilt.versionAlias) !== JSON.stringify({ hostname, effect: 'not-attempted', verified: false }))
    throw new Error('tarball version alias build context mismatch');
  if (git('status', '--porcelain=v1', '--untracked-files=no') !== '' || await readFile(resolve(cwd, 'user-note'), 'utf8') !== 'preserve') throw new Error('prebuilt consumer changed source');
  for (const branch of ['dev', 'main']) if (execute(root, 'git', ['--git-dir', remote, 'rev-parse', branch]) !== initial) throw new Error('prebuilt check changed remote refs');
  const executionOutput = resolve(checked.executionRoot, '.vercel/output'), moved = resolve(root, 'moved-artifact');
  await rename(resolve(checked.executionRoot, '.tmp/forge-vercel-release/prebuilt'), moved);
  await rm(executionOutput, { recursive: true });
  const loaded = execute(root, process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]))', resolve(moved, '.vercel/output/functions/alias.func/index.cjs')]);
  if (loaded !== 'public-tarball-layout') throw new Error('public tarball moved link closure failed');
  await verifyCompletionConsumer({ cwd, config: prebuilt, git, binary: binaries['forge-vercel-release'] });
  }
}
