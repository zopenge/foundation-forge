import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readMaskedOneTimePassword } from './bootstrap-otp.mjs';
import {
  createPackageManagerInvocation,
  findNpmCliPath,
} from './package-manager-command.mjs';
import { parseReleaseArguments } from './release-arguments.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import {
  ensureTrustedPublisherConfigurations,
  redactSecrets,
} from './trusted-publishers.mjs';
import { discoverWorkspacePackageModel, parseJsonDocuments } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const argumentsValue = parseReleaseArguments(process.argv.slice(2));
if (argumentsValue.logs || argumentsValue.mode !== undefined || argumentsValue.retry || argumentsValue.sha !== undefined) {
  throw new Error('configure-trusted-publishers accepts only repeatable --package options');
}
const [policy, model] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
const byName = new Map(model.packages.map((value) => [value.name, value]));
const packageNames = argumentsValue.packages.length === 0
  ? model.packages.map(({ name }) => name)
  : [...new Set(argumentsValue.packages)];
for (const name of packageNames) {
  if (!byName.has(name)) throw new Error(`unknown workspace package: ${name}`);
}

const otp = await readMaskedOneTimePassword();
const commandPrefix = [
  'exec',
  '--yes',
  `--package=npm@${policy.npmTrustVersion}`,
  '--',
  'npm',
  'trust',
];
const runNpmTrust = (args) => {
  const invocation = createPackageManagerInvocation('npm', [...commandPrefix, ...args], {
    npmCliPath: process.platform === 'win32' ? findNpmCliPath() : undefined,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_OTP: otp },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `npm trust exited with code ${String(result.status)}`;
    throw new Error(redactSecrets(message, [otp]));
  }
  return result.stdout;
};
const listConfigurations = async (name) => parseJsonDocuments(
  runNpmTrust(['list', name, '--json']),
).flatMap((document) => Array.isArray(document) ? document : [document]);
const expected = {
  environment: policy.environment,
  file: policy.workflow,
  repository: policy.githubRepository,
};
const results = await ensureTrustedPublisherConfigurations({
  configure: async (name) => {
    runNpmTrust([
      'github',
      name,
      '--file',
      expected.file,
      '--repo',
      expected.repository,
      '--env',
      expected.environment,
      '--allow-publish',
      '--yes',
      '--json',
    ]);
  },
  expected,
  listConfigurations,
  packageNames,
});
for (const result of results) {
  process.stdout.write(`${result.action === 'configured' ? 'Configured' : 'Verified'} GitHub Trusted Publisher for ${result.name}.\n`);
}
