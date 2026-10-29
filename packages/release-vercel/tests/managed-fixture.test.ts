import * as processes from 'node:child_process';
import * as files from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { git, managedFixture } from './helpers/managed-fixture.js';

declare module 'vitest' { interface TaskMeta { fixtureRoots?: string[] } }

vi.mock('node:child_process', async original => ({ ...await original<typeof processes>() }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof files>() }));
const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [], partialRoots: string[] = [];
const base = resolve(process.env.FORGE_CHECK_JOB_TEMP ?? resolve(import.meta.dirname, '../../../.tmp'), 'managed-release-tests');
const fixture = async () => { const value = await managedFixture(); fixtures.push(value); return value; };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) await value.dispose();
  // 失败回归也只清理本例实际创建的目录，不能扫描或删除历史 fixture。
  for (const root of partialRoots.splice(0)) {
    let target: string;
    try { target = await files.realpath(root); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
    const inside = relative(base, target);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('unexpected partial fixture root');
    await files.rm(target, { recursive: true, force: true });
  }
});

function bytes(cwd: string, object: string): Buffer {
  const result = processes.spawnSync('git', ['show', object], { cwd, windowsHide: true, shell: false });
  expect(result.status).toBe(0); expect(result.signal).toBeNull();
  return result.stdout;
}

it('prepares the real two-commit history and clean index with at most five Git invocations', async () => {
  const calls = vi.spyOn(processes, 'spawnSync');
  const f = await fixture(), count = calls.mock.calls.filter(([command]) => command === 'git').length;
  const options = calls.mock.calls.map(call => call[2]); calls.mockRestore();
  expect(count).toBeLessThanOrEqual(5);
  expect(options.every(option => option?.windowsHide === true && option.shell === false)).toBe(true);
  expect(f.cwd).toContain('source 空间 with spaces');
  expect(git(f.cwd, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  expect(git(f.cwd, 'branch', '--show-current')).toBe('dev');
  expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.sha);
  expect(git(f.cwd, 'rev-parse', 'HEAD^')).toBe(f.initial);
  expect(git(f.cwd, 'rev-list', '--count', 'HEAD')).toBe('2');
  expect(git(f.cwd, 'log', '--format=%s', 'HEAD')).toBe('candidate\ninitial');
  expect(git(f.cwd, 'log', '--format=%an <%ae>', 'HEAD').split('\n')).toEqual(['Fixture <fixture@example.invalid>', 'Fixture <fixture@example.invalid>']);
  expect(git(f.cwd, 'config', '--get', 'remote.origin.url')).toBe(f.remote);
  expect(git(f.cwd, 'config', '--get', 'remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*');
  const localImportConfig = processes.spawnSync('git', ['config', '--local', '--get-regexp', '^fastimport\\.'], {
    cwd: f.cwd, windowsHide: true, shell: false, encoding: 'utf8',
  });
  expect(localImportConfig.status).toBe(1); expect(localImportConfig.stdout).toBe('');
  expect(git(f.remote, 'rev-parse', '--is-bare-repository')).toBe('true');
  for (const branch of ['dev', 'main']) {
    expect(f.ref(branch)).toBe(f.initial);
    expect(git(f.cwd, 'rev-parse', `refs/remotes/origin/${branch}`)).toBe(f.initial);
  }
  const names = ['.gitignore', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'release.config.json', 'source.txt'].sort();
  expect(git(f.cwd, 'ls-tree', '-r', '--name-only', f.initial).split('\n').sort()).toEqual(names);
  expect(git(f.cwd, 'ls-tree', '-r', '--name-only', f.sha).split('\n').sort()).toEqual(names);
  for (const name of names) {
    expect(bytes(f.cwd, `${f.sha}:${name}`)).toEqual(await files.readFile(resolve(f.cwd, name)));
    expect(bytes(f.cwd, `${f.initial}:${name}`)).toEqual(name === 'source.txt' ? Buffer.from('initial\n') : bytes(f.cwd, `${f.sha}:${name}`));
  }
  expect(bytes(f.cwd, `${f.sha}:source.txt`)).toEqual(Buffer.from('candidate\n'));
  expect(JSON.parse(bytes(f.cwd, `${f.initial}:release.config.json`).toString('utf8'))).toEqual(f.config);
  git(f.cwd, 'fsck', '--strict'); git(f.remote, 'fsck', '--strict');
});

it('keeps fixtures independent through real commit, push, clone and cleanup', async () => {
  const first = await fixture(), second = await fixture();
  expect(first.root).not.toBe(second.root); expect(first.config).not.toBe(second.config);
  expect(await files.realpath(resolve(first.cwd, '.git'))).not.toBe(await files.realpath(resolve(second.cwd, '.git')));
  await files.writeFile(resolve(first.cwd, 'source.txt'), 'isolated change\n'); const next = first.commit();
  expect(git(first.cwd, 'rev-parse', 'HEAD^')).toBe(first.sha);
  git(first.cwd, 'push', 'origin', `${next}:dev`);
  expect(first.ref('dev')).toBe(next); expect(first.ref('main')).toBe(first.initial);
  expect(second.ref('dev')).toBe(second.initial); expect(second.ref('main')).toBe(second.initial);
  expect(git(second.cwd, 'rev-parse', 'HEAD')).toBe(second.sha);
  expect(await files.readFile(resolve(second.cwd, 'source.txt'), 'utf8')).toBe('candidate\n');
  const clone = resolve(first.root, 'independent clone 空间');
  git(first.root, 'clone', '--no-local', '--branch', 'dev', '--', first.remote, clone);
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(next);
  expect(bytes(clone, 'HEAD:source.txt')).toEqual(Buffer.from('isolated change\n'));
  // checkout 遵循本机 autocrlf；提交字节仍固定为 LF，索引必须与工作树一致。
  expect((await files.readFile(resolve(clone, 'source.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('isolated change\n');
  expect(git(clone, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
  await first.dispose(); await expect(files.lstat(first.root)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await files.readFile(resolve(second.cwd, 'source.txt'), 'utf8')).toBe('candidate\n');
});

it('cleans a partially prepared fixture when Git fails and preserves the original error', async () => {
  const created = vi.spyOn(files, 'mkdtemp'), failure = new Error('fixture Git start failure');
  vi.spyOn(processes, 'spawnSync').mockImplementation(() => { throw failure; });
  await expect(managedFixture()).rejects.toBe(failure);
  const root = await created.mock.results[0]?.value;
  if (typeof root !== 'string') throw new Error('fixture root was not created'); partialRoots.push(root);
  await expect(files.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['remote import', 'index'])('cleans after %s fails without removing another live fixture', async point => {
  const survivor = await fixture(), created = vi.spyOn(files, 'mkdtemp');
  const original = processes.spawnSync, failure = new Error(`fixture ${point} failure`);
  const commands = vi.spyOn(processes, 'spawnSync').mockImplementation((command, args, options) => {
    const selected = point === 'index' ? args?.includes('read-tree')
      : args?.includes('fast-import') && String(options?.cwd).endsWith('remote.git');
    if (command === 'git' && selected) throw failure;
    return original(command, args, options);
  });
  await expect(managedFixture()).rejects.toBe(failure); commands.mockRestore();
  const root = await created.mock.results[0]?.value;
  if (typeof root !== 'string') throw new Error('fixture root was not created'); partialRoots.push(root);
  await expect(files.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(git(survivor.cwd, 'rev-parse', 'HEAD')).toBe(survivor.sha);
  expect(survivor.ref('dev')).toBe(survivor.initial);
});

it('retains both errors when preparation and owned cleanup fail', async () => {
  const created = vi.spyOn(files, 'mkdtemp'), failure = new Error('fixture Git failure'), cleanup = new Error('fixture cleanup failure');
  vi.spyOn(processes, 'spawnSync').mockImplementation(() => { throw failure; });
  vi.spyOn(files, 'rm').mockRejectedValue(cleanup);
  const outcome = await managedFixture().then(() => undefined, (error: unknown) => error);
  const root = await created.mock.results[0]?.value;
  if (typeof root !== 'string') throw new Error('fixture root was not created'); partialRoots.push(root);
  expect(outcome).toBeInstanceOf(AggregateError);
  if (!(outcome instanceof AggregateError)) throw outcome;
  expect(outcome.errors).toEqual([failure, cleanup]); expect(outcome.cause).toBe(cleanup);
});

for (const kind of ['junction', 'directory'] as const) {
it(`refuses a replaced ${kind} fixture root without deleting another fixture`, async ({ task }) => {
  const first = await fixture(), second = await fixture(), saved = first.root + '-original';
  task.meta.fixtureRoots = [first.root, second.root];
  const sentinel = resolve(second.root, 'independent-sentinel');
  await files.writeFile(sentinel, 'preserve sibling');
  await files.rename(first.root, saved);
  let replacementIdentity: Awaited<ReturnType<typeof files.lstat>> | undefined;
  const restore = async () => {
    const current = await files.lstat(first.root, { bigint: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (current) {
      if (!replacementIdentity || current.dev !== replacementIdentity.dev || current.ino !== replacementIdentity.ino)
        throw new Error('replacement fixture identity changed; retained');
      if (current.isSymbolicLink()) await files.unlink(first.root);
      else await files.rm(first.root, { recursive: true, force: true });
    }
    await files.rename(saved, first.root);
  };
  try {
    if (kind === 'junction') await files.symlink(second.root, first.root, process.platform === 'win32' ? 'junction' : 'dir');
    else { await files.mkdir(first.root); await files.writeFile(resolve(first.root, 'replacement-sentinel'), 'preserve replacement'); }
    replacementIdentity = await files.lstat(first.root, { bigint: true });
    await expect(first.dispose()).rejects.toThrow('fixture root identity changed');
    expect(await files.readFile(sentinel, 'utf8')).toBe('preserve sibling');
    expect(git(second.cwd, 'rev-parse', 'HEAD')).toBe(second.sha);
    if (kind === 'directory') expect(await files.readFile(resolve(first.root, 'replacement-sentinel'), 'utf8')).toBe('preserve replacement');
  } finally { await restore(); }
});
}
