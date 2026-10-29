import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assertCandidate } from '../src/node/git.js';
import { ReleaseError } from '../src/node/errors.js';
import { git, managedFixture } from './helpers/managed-fixture.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };
function feed(f: Awaited<ReturnType<typeof fixture>>, value: string | Uint8Array): void {
  vi.spyOn(f.execution, 'streamGit').mockImplementationOnce(async (_args, consume) => {
    consume(typeof value === 'string' ? Buffer.from(value) : value);
  });
}

it('reads branch, HEAD and dirty state in one fresh Git observation on every candidate check', async () => {
  const f = await fixture(), query = vi.spyOn(f.execution, 'streamGit');
  await expect(assertCandidate(f.execution, f.config, f.sha)).resolves.toBe(f.sha);
  expect(query).toHaveBeenCalledTimes(1);
  await writeFile(resolve(f.cwd, 'untracked 有 空格'), 'new');
  await expect(assertCandidate(f.execution, f.config, f.sha)).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED', details: { reason: 'WORKTREE_CHANGED' } });
});

it('keeps a valid long branch usable with a small application capture budget', async () => {
  const f = await fixture(), branch = `feature/${'x'.repeat(112)}`;
  git(f.cwd, 'switch', '--create', branch);
  Object.assign(f.config.git, { developmentBranch: branch });
  Object.assign(f.config.limits, { maxOutputBytes: 160 });
  await expect(assertCandidate(f.execution, f.config, f.sha)).resolves.toBe(f.sha);
});

it('keeps branch and HEAD mismatch diagnostics distinct and preserves abnormal process failures', async () => {
  const f = await fixture(); git(f.cwd, 'switch', '--detach', f.sha);
  await expect(assertCandidate(f.execution, f.config, f.sha)).rejects.toMatchObject({ code: 'GIT_BRANCH' });
  git(f.cwd, 'switch', 'dev');
  await expect(assertCandidate(f.execution, f.config, f.initial)).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED', details: { reason: 'HEAD_CHANGED' } });
  const failure = new ReleaseError('PROCESS_STATE_UNKNOWN'); vi.spyOn(f.execution, 'streamGit').mockRejectedValueOnce(failure);
  await expect(assertCandidate(f.execution, f.config, f.sha)).rejects.toBe(failure);
});

it('does not interpret a renamed path resembling a header as clean metadata', async () => {
  const f = await fixture(), name = `# branch.oid ${f.initial}`;
  git(f.cwd, 'mv', 'source.txt', name); const sha = f.commit(); git(f.cwd, 'mv', name, 'renamed.txt');
  await expect(assertCandidate(f.execution, f.config, sha)).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED', details: { reason: 'WORKTREE_CHANGED' } });
});

it.each(['missing-head', 'duplicate-head', 'missing-terminator', 'empty-record'])('rejects %s observations instead of treating unknown metadata as clean', async mode => {
  const f = await fixture();
  const head = `# branch.oid ${f.sha}\0`, branch = '# branch.head dev\0';
  const status = mode === 'missing-head' ? branch : mode === 'duplicate-head' ? head + head + branch
    : mode === 'empty-record' ? head + '\0' + branch : (head + branch).slice(0, -1);
  feed(f, status);
  await expect(assertCandidate(f.execution, f.config, f.sha)).rejects.toMatchObject({ code: 'GIT_FAILED', details: { reason: 'STATUS_PROTOCOL' } });
});

it('accepts optional future headers without changing candidate semantics', async () => {
  const f = await fixture();
  feed(f, `# branch.oid ${f.sha}\0# branch.head dev\0# branch.ab +? -?\0# future-header fixture\0`);
  await expect(assertCandidate(f.execution, f.config, f.sha)).resolves.toBe(f.sha);
});

it('rejects invalid UTF-8 metadata and preserves the candidate timeout classification', async () => {
  const f = await fixture(); feed(f, Uint8Array.from([0xff, 0]));
  await expect(assertCandidate(f.execution, f.config, f.sha)).rejects.toMatchObject({ code: 'GIT_FAILED', details: { reason: 'STATUS_PROTOCOL', protocolReason: 'INVALID_UTF8' } });
  vi.spyOn(f.execution, 'streamGit').mockRejectedValueOnce(new ReleaseError('GIT_FAILED', { reason: 'STREAM_FAILED', termination: 'timeout', exitCode: null }));
  await expect(assertCandidate(f.execution, f.config, f.sha)).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT', details: { step: 'git' } });
});
