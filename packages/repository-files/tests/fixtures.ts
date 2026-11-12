import { execFile, type ExecFileException } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { ensureTestTemporaryDirectory } from '../../../scripts/test-temporary-directory.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const testRoot = resolve(repositoryRoot, 'tmp/repository-files-tests');
interface OwnedRepository { readonly root: string; readonly dev: bigint; readonly ino: bigint; readonly realPath: string }
interface TestLifecycle {
  readonly signal: AbortSignal;
  onTestFinished(handler: () => Promise<void>, timeout?: number): unknown;
}
export interface RepositoryFixture {
  readonly signal: AbortSignal;
  createRoot(): Promise<string>;
  runGit(cwd: string, args: readonly string[]): Promise<string>;
}

export const runGit = (cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> => {
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    let outcome: { error: ExecFileException | null; stdout: string } | undefined;
    const child = execFile('git', [...args], { cwd, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1_024 * 1_024,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com' },
    }, (error, stdout) => { outcome = { error, stdout }; });
    child.once('close', () => {
      if (signal.aborted) { reject(signal.reason); return; }
      if (!outcome) { reject(new Error('FIXTURE_COMMAND_RESULT_MISSING')); return; }
      if (outcome.error) reject(outcome.error); else accept(outcome.stdout);
    });
  });
};

export async function removeTestRepository(owned: OwnedRepository): Promise<void> {
  const base = await ensureTestTemporaryDirectory(repositoryRoot, testRoot), inside = relative(base, owned.root);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('FIXTURE_ROOT_ESCAPED');
  let current;
  try { current = await lstat(owned.root, { bigint: true }); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino
    || await realpath(owned.root) !== owned.realPath) throw new Error('FIXTURE_IDENTITY_CHANGED');
  await rm(owned.root, { recursive: true, force: true });
}

export async function createTestRepository({ signal, onCreated }:
  { signal: AbortSignal; onCreated?: (owned: OwnedRepository) => void }): Promise<OwnedRepository> {
  signal.throwIfAborted();
  const base = await ensureTestTemporaryDirectory(repositoryRoot, testRoot);
  signal.throwIfAborted();
  const root = await mkdtemp(resolve(base, 'r-')), identity = await lstat(root, { bigint: true });
  const owned = { root, dev: identity.dev, ino: identity.ino, realPath: await realpath(root) };
  try {
    if (!identity.isDirectory() || identity.isSymbolicLink() || owned.realPath !== root) throw new Error('FIXTURE_IDENTITY_CHANGED');
    onCreated?.(owned);
    signal.throwIfAborted();
    await runGit(root, ['init', '--quiet'], signal);
    return owned;
  } catch (error) {
    const failures = [error];
    try { await removeTestRepository(owned); }
    catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'FIXTURE_INITIALIZATION_CLEANUP', { cause: error });
    throw error;
  }
}

export function withTestRepositories<T>(context: TestLifecycle, body: (fixture: RepositoryFixture) => Promise<T>): Promise<T> {
  const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
  const roots: OwnedRepository[] = [], pending = new Set<Promise<unknown>>();
  const track = <V>(work: Promise<V>): Promise<V> => {
    pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  // 先登记收尾，再开始初始化；正文排空后才删除目录，避免取消后的文件写入与删除竞争。
  context.onTestFinished(async () => {
    controller.abort(new Error('REPOSITORY_FIXTURE_CLEANUP'));
    await work.then(() => {}, () => {});
    await Promise.allSettled([...pending]);
    const results = await Promise.allSettled(roots.map(removeTestRepository));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'FIXTURE_CLEANUP');
  }, 15_000);
  const fixture: RepositoryFixture = { signal,
    createRoot: () => track(createTestRepository({ signal, onCreated: owned => { roots.push(owned); } })).then(owned => owned.root),
    runGit: (cwd, args) => track(runGit(cwd, args, signal)),
  };
  const work = Promise.resolve().then(() => { signal.throwIfAborted(); return body(fixture); });
  return work;
}
