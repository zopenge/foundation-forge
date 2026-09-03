import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseOneTimePassword,
  readMaskedOneTimePassword,
} from './bootstrap-otp.mjs';

const otp = process.env.NPM_CONFIG_OTP === undefined
  ? await readMaskedOneTimePassword()
  : parseOneTimePassword(process.env.NPM_CONFIG_OTP);
const publishScript = fileURLToPath(new URL('./publish-if-needed.mjs', import.meta.url));

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    publishScript,
    '--tag',
    'next',
    '--bootstrap',
  ], {
    env: { ...process.env, NPM_CONFIG_OTP: otp },
    shell: false,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`Bootstrap publisher exited with code ${String(code ?? 1)}`));
    }
  });
});
