import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { readMaskedOneTimePassword } from './bootstrap-otp.mjs';
import { npmAuthenticationArguments, parseReleaseAuthenticationArguments,
  readReleaseAuthentication, removeNpmOtp } from './release-authentication.mjs';
import {
  createPackageManagerInvocation,
  findNpmCliPath,
} from './package-manager-command.mjs';
import { parseReleaseArguments } from './release-arguments.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { createNpmEnvironment } from './release-environment.mjs';
import {
  ensureTrustedPublisherConfigurations,
  redactSecrets,
} from './trusted-publishers.mjs';
import { discoverWorkspacePackageModel, parseJsonDocuments } from './workspace-packages.mjs';

export const configureTrustedPublishers = async ({ model, policy, packageNames: selectedNames = [],
  authMode = 'otp', environment = process.env, input = process.stdin, output = process.stdout,
  readOtp = () => readMaskedOneTimePassword(input, output),
  execute = (invocation, env, { stdio }) => spawnSync(invocation.command, invocation.args, {
    cwd: model.repositoryRoot, encoding: 'utf8', env, shell: false, windowsHide: true,
    stdio,
  }),
}) => {
  const authenticationArguments = npmAuthenticationArguments(authMode);
  const byName = new Map(model.packages.map((value) => [value.name, value]));
  const packageNames = selectedNames.length === 0
    ? model.packages.map(({ name }) => name)
    : [...new Set(selectedNames)];
  for (const name of packageNames) {
    if (!byName.has(name)) throw new Error(`unknown workspace package: ${name}`);
  }

  let otp;
  let authenticated = false;
  let npmEnvironment = authMode === 'web' ? removeNpmOtp(environment) : environment;
  const authenticate = async () => {
    npmEnvironment = await readReleaseAuthentication({ authMode, environment, input, output, readOtp });
    otp = npmEnvironment.NPM_CONFIG_OTP;
    authenticated = true;
  };
  const commandPrefix = [
    'exec',
    '--yes',
    `--package=npm@${policy.npmTrustVersion}`,
    '--',
    'npm',
    'trust',
  ];
  const runNpmTrust = (args, interactive = false) => {
    const invocation = createPackageManagerInvocation('npm', [...commandPrefix, ...args,
      ...(interactive ? authenticationArguments : [])], {
      npmCliPath: process.platform === 'win32' ? findNpmCliPath() : undefined,
    });
    const result = execute(invocation, createNpmEnvironment(npmEnvironment),
      { stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) {
      const message = result.stderr || result.stdout || `npm trust exited with code ${String(result.status)}`;
      const error = new Error(redactSecrets(message, [otp ?? '']));
      // 只有 npm 的结构化认证错误可以进入交互；其余失败保持原样。
      try {
        if (parseJsonDocuments(result.stdout ?? '').some((document) => document?.error?.code === 'EOTP')) {
          error.code = 'EOTP';
        }
      } catch { /* 格式错误不能成为重试认证的依据。 */ }
      throw error;
    }
    if (result.stderr) process.stderr.write(redactSecrets(result.stderr, [otp ?? '']));
    return result.stdout;
  };
  const listConfigurations = async (name) => {
    const read = () => runNpmTrust(['list', name, '--json']);
    let response;
    try { response = read(); }
    catch (error) {
      if (error.code !== 'EOTP' || (authMode === 'otp' && authenticated)) throw error;
      await authenticate();
      process.stderr.write(`${error.message}\n`);
      if (authMode === 'web') runNpmTrust(['list', name], true);
      // 交互输出不作为配置证据；每次读取最多一次授权及一次独立 JSON 回读。
      response = read();
    }
    return parseJsonDocuments(response).flatMap((document) => Array.isArray(document) ? document : [document]);
  };
  const expected = {
    environment: policy.environment,
    file: policy.workflow,
    repository: policy.githubRepository,
  };
  const results = await ensureTrustedPublisherConfigurations({
    configure: async (name) => {
      if (!authenticated) await authenticate();
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
        ...(authMode === 'web' ? [] : ['--json']),
      ], authMode === 'web');
    },
    expected,
    listConfigurations,
    packageNames,
  });
  for (const result of results) {
    process.stdout.write(`${result.action === 'configured' ? 'Configured' : 'Verified'} GitHub Trusted Publisher for ${result.name}.\n`);
  }
  return results;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const { authMode, args: remaining } = parseReleaseAuthenticationArguments(process.argv.slice(2));
  const args = parseReleaseArguments(remaining);
  if (args.logs || args.mode !== undefined || args.retry || args.sha !== undefined) {
    throw new Error('configure-trusted-publishers accepts only repeatable --package and --auth-mode options');
  }
  const [policy, model] = await Promise.all([loadReleasePolicy(repositoryRoot), discoverWorkspacePackageModel({ repositoryRoot })]);
  await configureTrustedPublishers({ model, policy, packageNames: args.packages, authMode });
}
