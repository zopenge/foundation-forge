import { execFile, type ExecFileOptions } from 'node:child_process';

/** 取消/超时的 error 事件不等于关闭；总在 close 后才让调用方回收私有目录。 */
export function fixtureExec(command: string, args: readonly string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    let outcome: { error: Error | null; stdout: string; stderr: string } | undefined;
    const child = execFile(command, [...args], { ...options, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => { outcome = { error, stdout, stderr }; });
    child.once('close', () => {
      if (!outcome) reject(new Error('FIXTURE_CHILD_RESULT_MISSING'));
      else if (outcome.error) reject(outcome.error);
      else accept({ stdout: outcome.stdout, stderr: outcome.stderr });
    });
  });
}
