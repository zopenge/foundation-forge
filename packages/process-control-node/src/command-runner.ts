import { execFile } from 'node:child_process';
import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';

import type { ProcessCommandRunner } from './contracts.js';

export const runProcessCommand: ProcessCommandRunner = async (request) => new Promise((resolve, reject) => {
  execFile(
    request.command,
    [...request.args],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1_024 * 1_024,
      signal: request.signal,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(new ProcessControlError(
          request.signal?.aborted === true
            ? processControlErrorCodes.operationAborted
            : processControlErrorCodes.commandFailed,
          { command: request.command },
          error,
        ));
        return;
      }
      const exitCode = typeof error?.code === 'number' ? error.code : 0;
      resolve({ exitCode, stderr, stdout });
    },
  );
});
