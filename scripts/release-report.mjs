import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import { collectWorkspaceFingerprint } from './check-fingerprint.mjs';
import { redactKnownTokens } from './release-redaction.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identities = (packages) => packages.map(({ name, version }) => ({ name, version }));
const identity = (report) => ({ binding: report.binding, mode: report.mode, kind: report.kind,
  expectedCommit: report.expectedCommit, targets: identities(report.targets), packages: identities(report.packages) });
const states = new Set(['pending', 'started', 'succeeded', 'failed', 'unknown', 'not-required']);

export const captureReleaseBinding = async (model, policy) => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: model.repositoryRoot, encoding: 'utf8', shell: false, windowsHide: true,
  });
  if (result.status !== 0) throw new Error('RELEASE_SOURCE_UNKNOWN');
  return { commit: result.stdout.trim(),
    fingerprint: digest(await collectWorkspaceFingerprint(model.repositoryRoot)),
    registry: policy.registry, pnpmVersion: policy.pnpmVersion };
};

export const createReleaseReport = ({ binding, mode, targets, packages, expectedCommit, kind = 'verification' }) => {
  const report = { schemaVersion: 1, binding, mode, kind,
    ...(expectedCommit === undefined ? {} : { expectedCommit }),
    targets: identities(targets).map((value) => ({ ...value, publish: 'pending' })),
    packages: identities(packages),
    stages: { trustedPublisher: kind === 'bootstrap' ? 'pending' : 'not-required', registry: 'pending', consumer: 'pending' },
    updatedAt: new Date().toISOString(),
  };
  report.id = digest(identity(report));
  return report;
};

export const recordReleaseFailure = (report, stage, error) => {
  if (stage in report.stages) report.stages[stage] = 'failed';
  const failure = { stage, code: redactKnownTokens(String(error?.code ?? 'RELEASE_STAGE_FAILED')).slice(0, 128),
    message: redactKnownTokens(String(error?.message ?? error)).slice(0, 4_096) };
  report.firstError ??= failure;
  report.lastError = failure;
};

const assertContained = (root, path) => {
  const inside = relative(root, path);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('REPORT_PATH_OUTSIDE_RELEASE_DIRECTORY');
};

const reportDirectory = async (repositoryRoot) => {
  const root = resolve(repositoryRoot);
  const directory = resolve(root, '.tmp', 'release');
  await mkdir(directory, { recursive: true });
  assertContained(await realpath(root), await realpath(directory));
  return directory;
};

export const writeReleaseReport = async (repositoryRoot, report) => {
  if (digest(identity(report)) !== report.id) throw new Error('REPORT_INVALID_IDENTITY');
  const directory = await reportDirectory(repositoryRoot);
  const path = resolve(directory, `${report.mode}-${report.binding.commit}-${report.id.slice(0, 16)}.json`);
  report.updatedAt = new Date().toISOString();
  const next = `${path}.${process.pid}.tmp`;
  const payload = { ...report, checksum: digest(report) };
  try {
    await writeFile(next, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(next, path);
  } finally { await rm(next, { force: true }); }
  return path;
};

export const readReleaseReport = async (repositoryRoot, path) => {
  const directory = resolve(repositoryRoot, '.tmp', 'release');
  const absolute = resolve(repositoryRoot, path);
  assertContained(directory, absolute);
  assertContained(await realpath(directory), await realpath(absolute));
  let report;
  try {
    const { checksum, ...value } = JSON.parse(await readFile(absolute, 'utf8'));
    if (value.schemaVersion !== 1 || !['bootstrap', 'next', 'stable'].includes(value.mode)
      || !['bootstrap', 'verification'].includes(value.kind)
      || (value.kind === 'bootstrap' && value.mode !== 'bootstrap')
      || !/^[a-f0-9]{40,64}$/u.test(value.binding?.commit)
      || !/^[a-f0-9]{64}$/u.test(value.binding?.fingerprint)
      || (value.expectedCommit !== undefined && !/^[a-f0-9]{40,64}$/u.test(value.expectedCommit))
      || !Array.isArray(value.targets) || value.targets.length === 0 || !Array.isArray(value.packages)
      || !value.targets.every((target) => typeof target.name === 'string' && typeof target.version === 'string' && states.has(target.publish))
      || !['trustedPublisher', 'registry', 'consumer'].every((stage) => states.has(value.stages?.[stage]))
      || checksum !== digest(value) || value.id !== digest(identity(value))) throw new Error('invalid');
    report = value;
  } catch { throw new Error('REPORT_INVALID：报告损坏或格式不受支持'); }
  return report;
};

export const assertResumeBinding = (report, current) => {
  if (JSON.stringify(report.binding) !== JSON.stringify(current.binding)) {
    throw new Error('RELEASE_SOURCE_CHANGED：请使用报告对应的源码、依赖环境和验证工具续验');
  }
  if (JSON.stringify(identities(report.targets)) !== JSON.stringify(identities(current.targets))
    || JSON.stringify(report.packages) !== JSON.stringify(identities(current.packages))) {
    throw new Error('RELEASE_TARGETS_CHANGED：包版本或依赖闭包发生变化');
  }
  if (report.targets.some(({ publish }) => ['started', 'unknown'].includes(publish)
    || (report.kind === 'bootstrap' && publish !== 'succeeded'))) {
    throw new Error('PUBLISH_UNCONFIRMED：发布副作用未确认，续验不会尝试 publish');
  }
};

export const withReleaseLock = async (repositoryRoot, task) => {
  const directory = await reportDirectory(repositoryRoot);
  const path = resolve(directory, 'active.lock');
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('RELEASE_BUSY：存在发布或续验锁；先核实原进程与报告，不自动接管', { cause: error });
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await task();
  } finally { await handle.close(); await rm(path); }
};

export const printReleaseSummary = (report, path) => {
  const published = report.targets.filter(({ publish }) => publish === 'succeeded').map(({ name, version }) => `${name}@${version}`);
  const complete = report.targets.every(({ publish }) => publish === 'succeeded')
    && Object.values(report.stages).every((state) => ['succeeded', 'not-required'].includes(state));
  process.stdout.write(`${complete ? '发布验证完成' : '发布后仍有未完成阶段'}：${published.join(', ') || '尚无已确认发布项'}\n`);
  process.stdout.write(`阶段：${JSON.stringify(report.stages)}\n报告：${path}\n`);
  if (!complete) process.stdout.write(`续验：pnpm release:resume --report ${JSON.stringify(`.tmp/release/${basename(path)}`)}\n`);
};
