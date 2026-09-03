import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseOneTimePassword,
  readMaskedOneTimePassword,
} from './bootstrap-otp.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import {
  readPackageRegistryMetadata,
  selectBootstrapCandidates,
} from './release-registry.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const [policy, model] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
const bootstrapCandidates = selectBootstrapCandidates(await Promise.all(
  model.packages.map(async ({ name, version }) => ({
    metadata: await readPackageRegistryMetadata({ name, registry: policy.registry }),
    name,
    version,
  })),
));

const otp = process.env.NPM_CONFIG_OTP === undefined
  ? await readMaskedOneTimePassword()
  : parseOneTimePassword(process.env.NPM_CONFIG_OTP);
const publishScript = fileURLToPath(new URL('./publish-if-needed.mjs', import.meta.url));

const runScript = (script, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], {
    env,
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

await runScript(publishScript, ['--tag', 'next', '--bootstrap'], {
  ...process.env,
  NPM_CONFIG_OTP: otp,
});

if (bootstrapCandidates.length > 0) {
  const packageArguments = bootstrapCandidates.flatMap((name) => ['--package', name]);
  await runScript(
    fileURLToPath(new URL('./configure-trusted-publishers.mjs', import.meta.url)),
    packageArguments,
  );
  await runScript(
    fileURLToPath(new URL('./verify-release.mjs', import.meta.url)),
    ['--mode', 'bootstrap', ...packageArguments],
  );
}
