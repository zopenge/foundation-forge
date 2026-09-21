import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const runGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await exec('git', ['--no-optional-locks', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.quotepath=false', '-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
};
export const createRepository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'forge-source-snapshot-'));
  await runGit(root, ['init', '--quiet']);
  await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
  await runGit(root, ['add', '.gitignore']);
  await runGit(root, ['commit', '--quiet', '-m', 'init']);
  return root;
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
