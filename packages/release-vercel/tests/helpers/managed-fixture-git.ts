import { spawnSync } from 'node:child_process';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function run(cwd: string, args: string[], input?: Buffer): string {
  const result = spawnSync('git', args, { cwd, input, shell: false, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
}
export const git = (cwd: string, ...args: string[]): string => run(cwd, args);
const line = (text: string): Buffer => Buffer.from(`${text}\n`);
const data = (bytes: Buffer): Buffer => Buffer.concat([line(`data ${bytes.length}`), bytes, line('')]);

// 只批量准备夹具的固定历史；后续被测 commit/push 仍执行原真实 Git 命令。
export async function prepareManagedFixtureHistory(root: string, cwd: string, remote: string) {
  git(root, 'init', '--bare', remote); git(root, 'init', '-b', 'dev', cwd);
  await appendFile(resolve(cwd, '.git/config'), `\n[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[remote "origin"]\n\turl = ${JSON.stringify(remote)}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  const identity = `committer Fixture <fixture@example.invalid> ${Math.floor(Date.now() / 1000)} +0000`;
  const initial = [line('commit refs/heads/dev'), line('mark :1'), line(identity), data(Buffer.from('initial\n'))];
  for (const file of (await readdir(cwd, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (file.name === '.git') continue;
    if (!file.isFile() || !/^[a-zA-Z0-9_.-]+$/u.test(file.name)) throw new Error('unsupported managed fixture file');
    initial.push(line(`M 100644 inline ${file.name}`), data(await readFile(resolve(cwd, file.name))));
  }
  initial.push(line(''));
  const firstCommit = Buffer.concat(initial);
  const candidate = Buffer.concat([line('commit refs/heads/dev'), line('mark :2'), line(identity), data(Buffer.from('candidate\n')),
    line('from :1'), line('M 100644 inline source.txt'), data(Buffer.from('candidate\n')), line('')]);
  // 保留小 pack，避免 fast-import 内部再次启动 unpack-objects；不写入本地或全局配置。
  const importArgs = ['-c', 'fastimport.unpackLimit=0', 'fast-import', '--quiet', '--done'];
  const marks = run(cwd, importArgs, Buffer.concat([firstCommit, candidate,
    line('reset refs/remotes/origin/dev'), line('from :1'), line(''),
    line('reset refs/remotes/origin/main'), line('from :1'), line(''),
    line('get-mark :1'), line('get-mark :2'), line('done')])).split(/\r?\n/u);
  const remoteInitial = run(remote, importArgs, Buffer.concat([firstCommit,
    line('reset refs/heads/main'), line('from :1'), line(''), line('get-mark :1'), line('done')]));
  const [initialSha, sha] = marks;
  if (marks.length !== 2 || !initialSha || !sha || !/^[a-f0-9]{40}$/u.test(initialSha)
    || !/^[a-f0-9]{40}$/u.test(sha) || initialSha === sha || remoteInitial !== initialSha) throw new Error('managed fixture commit mismatch');
  await writeFile(resolve(cwd, 'source.txt'), 'candidate\n'); git(cwd, 'read-tree', 'HEAD');
  return { initial: initialSha, sha };
}
