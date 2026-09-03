import { execFile } from 'node:child_process';

import type { ProcessCommandRunner } from './contracts.js';

export const runProcessCommand: ProcessCommandRunner = async (request) => new Promise((resolve) => {
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
      const exitCode = error === null
        ? 0
        : typeof error.code === 'number'
          ? error.code
          : 1;
      resolve({ exitCode, stderr, stdout });
    },
  );
});
