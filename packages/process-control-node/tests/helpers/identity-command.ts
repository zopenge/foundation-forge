import { execFile, type ExecFileException } from 'node:child_process';
import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';
import type { ProcessCommandRunner } from '../../src/contracts.js';

/** 真实身份探测的测试专属传输，句柄由本次调用创建和回收。 */
export function startIdentityCommand(request: Parameters<ProcessCommandRunner>[0]) {
  let outcome: { error: ExecFileException | null; stdout: string; stderr: string } | undefined;
  const child = execFile(request.command, [...request.args], { encoding: 'utf8', maxBuffer: 16 * 1_024 * 1_024,
    signal: request.signal, windowsHide: true }, (error, stdout, stderr) => { outcome = { error, stdout, stderr }; });
  const completion: ReturnType<ProcessCommandRunner> = new Promise((accept, reject) => {
    // AbortError 的 callback 可以早于 close；成功和失败都必须等待真实关闭。
    child.once('close', () => {
      if (!outcome) { reject(new Error('IDENTITY_COMMAND_RESULT_MISSING')); return; }
      const { error, stdout, stderr } = outcome;
      if (error && typeof error.code !== 'number') {
        reject(new ProcessControlError(request.signal?.aborted ? processControlErrorCodes.operationAborted : processControlErrorCodes.commandFailed,
          { command: request.command }, error));
      } else accept({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
  return { child, completion };
}
