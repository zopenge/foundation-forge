import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { freezeManagedSource, assertSourceFrozen, inspectCommitTree, readCommittedConfig } from '../src/node/source.js';
import { ReleaseError } from '../src/node/errors.js';
import { git, managedFixture } from './helpers/managed-fixture.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };
it.each([
  new ReleaseError('GIT_FAILED', { exitCode: null, termination: 'start-failure' }),
  new ReleaseError('GIT_FAILED', { exitCode: 128, termination: 'termination-failure' }),
  new ReleaseError('GIT_FAILED', { exitCode: 128, termination: 'exit' }),
  new ReleaseError('COMMAND_TIMEOUT', { step: 'git' }),
  new ReleaseError('CANCELLED'),
  new ReleaseError('PROCESS_STATE_UNKNOWN'),
])('preserves committed-config observation failure $code with $details', async failure => {
  const f = await fixture();
  const observation = vi.spyOn(f.execution, 'git').mockRejectedValueOnce(failure);
  try { await expect(readCommittedConfig(f.execution, f.sha, 'release.config.json')).rejects.toBe(failure); }
  finally { observation.mockRestore(); }
  await expect(readCommittedConfig(f.execution, f.sha, 'release.config.json')).resolves.toMatchObject({ config: f.config });
});
it('classifies a genuinely absent committed-config path after a normal Git exit', async () => {
  const f = await fixture();
  await expect(readCommittedConfig(f.execution, f.sha, 'absent.json')).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED', details: { reason: 'CONFIG_NOT_COMMITTED' } });
});
it.each(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'])('refuses inherited %s context before creating an isolated checkout', async name => {
  const f = await fixture();
  vi.stubEnv(name, resolve(f.cwd, name === 'GIT_DIR' ? '.git' : name === 'GIT_INDEX_FILE' ? '.git/index' : '.git/objects'));
  await expect(freezeManagedSource(f.cwd, 'release.config.json', f.execution)).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED', details: { reason: 'GIT_CONTEXT_ENV' } });
});
it('freezes an unpublished commit without touching untracked paths or remote refs', async () => {
  const f = await fixture(); const path = resolve(f.cwd, 'untracked.txt'); await writeFile(path, 'user bytes\n');
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  expect(source.sha).toBe(f.sha); expect(source.config).toEqual(f.config);
  await inspectCommitTree(source, f.execution); await assertSourceFrozen(source, f.execution);
  expect(await readFile(path, 'utf8')).toBe('user bytes\n');
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  expect(git(f.cwd, 'branch', '--show-current')).toBe('dev');
});
it.each(['index', 'tracked', 'head', 'remote', 'remote-removed', 'config'])('rejects source %s changes', async mode => {
  const f = await fixture(); const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  if (mode === 'remote') git(f.cwd, 'remote', 'set-url', 'origin', resolve(f.root, 'other.git'));
  else if (mode === 'remote-removed') git(f.cwd, 'remote', 'remove', 'origin');
  else if (mode === 'config') await writeFile(resolve(f.cwd, 'release.config.json'), '{}');
  else { await writeFile(resolve(f.cwd, 'source.txt'), 'changed'); if (mode !== 'tracked') git(f.cwd, 'add', '-u');
    if (mode === 'head') git(f.cwd, 'commit', '-m', 'later'); }
  await expect(assertSourceFrozen(source, f.execution)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
});
it.each(['GIT_FAILED', 'COMMAND_TIMEOUT', 'PROCESS_STATE_UNKNOWN'] as const)('preserves %s when frozen-source observation fails', async code => {
  const f = await fixture(); const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const failure = new ReleaseError(code, { step: 'git', ...(code === 'GIT_FAILED' ? { exitCode: null, termination: 'termination-failure' } : {}) });
  const observation = vi.spyOn(f.execution, 'git').mockRejectedValueOnce(failure);
  try { await expect(assertSourceFrozen(source, f.execution)).rejects.toBe(failure); }
  finally { observation.mockRestore(); }
  await expect(assertSourceFrozen(source, f.execution)).resolves.toBeUndefined();
});
it.each(['remote', 'worktree', 'index'])('preserves abnormal closure with exit code one during %s observation', async point => {
  const f = await fixture(); const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const failure = new ReleaseError('GIT_FAILED', { step: 'git', exitCode: 1, termination: 'termination-failure' });
  const original = f.execution.git.bind(f.execution);
  const observation = vi.spyOn(f.execution, 'git').mockImplementation(args => {
    const targeted = point === 'remote' ? args[0] === 'config' && args[1] === '--get-regexp'
      : args[0] === 'diff' && args.includes('--cached') === (point === 'index');
    return targeted ? Promise.reject(failure) : original(args);
  });
  try { await expect(assertSourceFrozen(source, f.execution)).rejects.toBe(failure); }
  finally { observation.mockRestore(); }
  await expect(assertSourceFrozen(source, f.execution)).resolves.toBeUndefined();
});
it('rejects an untracked configuration even when it matches the candidate', async () => {
  const f = await fixture(); await writeFile(resolve(f.cwd, 'other.json'), JSON.stringify(f.config));
  await expect(freezeManagedSource(f.cwd, 'other.json', f.execution)).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
});
it('reads a complete tree larger than the command capture bound, with UTF-8 paths', async () => {
  const f = await fixture();
  for (let i = 0; i < 140; i++) await writeFile(resolve(f.cwd, `目录-file-${String(i).padStart(4, '0')}.txt`), 'data');
  git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-m', 'large tree');
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(inspectCommitTree(source, f.execution)).resolves.toBeUndefined();
});
it('rejects LFS pointer content instead of accepting an incomplete checkout', async () => {
  const f = await fixture();
  await writeFile(resolve(f.cwd, 'source.txt'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 100\n`); f.commit();
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(inspectCommitTree(source, f.execution)).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
});
it.each(['120000', '160000', 'newline'])('rejects unsupported committed tree entry %s', async mode => {
  const f = await fixture(); const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const oid = mode === '160000' ? f.sha : git(f.cwd, 'rev-parse', 'HEAD:source.txt');
  const tree = spawnSync('git', ['hash-object', '-t', 'tree', '--stdin', '--literally', '-w'], { cwd: f.cwd, shell: false,
    input: Buffer.concat([Buffer.from(`${mode === 'newline' ? '100644' : mode} ${mode === 'newline' ? 'bad\nname' : 'unsupported'}\0`), Buffer.from(oid, 'hex')]), encoding: 'utf8' });
  expect(tree.status, tree.stderr).toBe(0);
  const sha = git(f.cwd, 'commit-tree', tree.stdout.trim(), '-p', f.sha, '-m', 'synthetic tree');
  if (mode === 'newline' && process.platform !== 'win32') await expect(inspectCommitTree({ ...source, sha }, f.execution)).resolves.toBeUndefined();
  else await expect(inspectCommitTree({ ...source, sha }, f.execution)).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
});
