import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { sourceTestTemporaryDirectory } from './temporary-directory.js';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const runGit = async (cwd: string, args: readonly string[], input?: Buffer): Promise<string> => {
  const pending = exec('git', ['--no-optional-locks', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.quotepath=false', '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (input) pending.child.stdin?.end(input);
  const result = await pending;
  return result.stdout;
};
export const createRepository = async ({ files = {} }: { files?: Readonly<Record<string, string>> } = {}): Promise<string> => {
  for (const path of Object.keys(files)) {
    if (/[\\:\0\r\n]/u.test(path) || path.split('/').some(part => ['', '.', '..', '.git'].includes(part.toLowerCase()))) throw new Error('FIXTURE_PATH');
  }
  const root = await mkdtemp(join(await sourceTestTemporaryDirectory(), 'forge-source-snapshot-'));
  try {
    await runGit(root, ['init', '--quiet']);
    const head = (await readFile(join(root, '.git/HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: refs/heads/')) throw new Error('FIXTURE_HEAD');
    const line = (text: string) => Buffer.from(`${text}\n`);
    const data = (bytes: Buffer) => Buffer.concat([line(`data ${bytes.length}`), bytes, line('')]);
    const input = [line(`commit ${head.slice(5)}`), line(`committer Fixture <fixture@example.invalid> ${Math.floor(Date.now() / 1000)} +0000`), data(Buffer.from('init\n'))];
    // 固定初始输入只导入一次；后续变更、gitlink 与 clone 仍执行真实 Git。
    for (const [path, content] of Object.entries({ '.gitignore': 'ignored/\n', ...files })) {
      const target = join(root, path); await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content, 'utf8');
      input.push(line(`M 100644 inline ${JSON.stringify(path)}`), data(Buffer.from(content)));
    }
    input.push(line(''), line('done'));
    await runGit(root, ['-c', 'fastimport.unpackLimit=0', 'fast-import', '--quiet', '--done'], Buffer.concat(input));
    await runGit(root, ['read-tree', 'HEAD']);
    return root;
  } catch (error) {
    const failures = [error];
    try { await rm(root, { recursive: true, force: true }); }
    catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'fixture preparation and cleanup failed', { cause: error });
    throw error;
  }
};
export const addCommittedFile = async (root: string, path: string, content = 'export const value = 1\n'): Promise<void> => {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
  await runGit(root, ['add', path]);
  await runGit(root, ['commit', '--quiet', '-m', `add ${path}`]);
};
export const removeRepository = async (root: string): Promise<void> => { await rm(root, { recursive: true, force: true }); };

// 使用原生 clone 建立真实 gitlink，避免 Windows submodule add 的 shell 启动开销。
export const addFixtureSubmodule = async (root: string, source: string): Promise<void> => {
  const gitDir = join(root, '.git', 'modules', 'modules', 'lib');
  await mkdir(join(gitDir, '..'), { recursive: true });
  await runGit(root, ['clone', '--quiet', '--local', '--separate-git-dir', gitDir, source, 'modules/lib']);
  await writeFile(join(root, '.gitmodules'), '[submodule "modules/lib"]\n\tpath = modules/lib\n\turl = ' + source.replaceAll('\\', '/') + '\n', 'utf8');
  await runGit(root, ['config', 'submodule.modules/lib.url', source]);
  await runGit(root, ['add', '.gitmodules', 'modules/lib']);
};
