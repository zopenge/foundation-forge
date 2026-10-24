import assert from 'node:assert/strict';
import test from 'node:test';

const implementation = async () => import('../release-install.mjs').catch((error) => {
  assert.fail(`缺少安装可靠性实现：${error.code}`);
});
const names = new Set(['@example/pkg']);
const errorOutput = (code, extra = {}) => JSON.stringify({ name: 'pnpm', level: 'error', code,
  message: 'fetch failed', ...extra });

test('仅已确认包的缺失、限流及临时网络错误允许安装重试', async () => {
  const { createInstallFailure, isRetryableInstallError } = await implementation();
  const check = (code, extra = {}, output = '') => isRetryableInstallError(
    createInstallFailure(`${output}\n${errorOutput(code, extra)}`, '', 1), names,
  );
  assert.equal(check('ERR_PNPM_FETCH_404', { request: { url: 'https://registry.npmjs.org/@example%2Fpkg' } }), true);
  assert.equal(check('ERR_PNPM_FETCH_404', { request: { url: 'https://registry.npmjs.org/@example%2Fother' } }), false);
  assert.equal(check('ERR_PNPM_FETCH_404'), false);
  assert.equal(check('ERR_PNPM_NO_MATCHING_VERSION', { wantedDependency: { name: '@example/pkg' } }), true);
  assert.equal(check('ERR_PNPM_FETCH_503'), true);
  assert.equal(check('ERR_PNPM_FETCH_429'), true);
  assert.equal(check('ECONNRESET'), true);
  assert.equal(check('ERR_PNPM_META_FETCH_FAIL', { cause: { code: 'ECONNRESET' } }), true);
  assert.equal(check('ERR_PNPM_META_FETCH_FAIL', { cause: { code: 'CERT_HAS_EXPIRED' } }), false);
  for (const code of ['ERR_PNPM_FETCH_401', 'ERR_PNPM_FETCH_403', 'ERR_PNPM_TARBALL_INTEGRITY',
    'ELIFECYCLE', 'EPERM', 'ERR_PNPM_UNKNOWN']) assert.equal(check(code), false);
  assert.equal(check('ERR_PNPM_FETCH_503', {}, JSON.stringify({ name: 'pnpm:lifecycle', stage: 'install' })), false);
});

test('npm trust 成功时仍显示剩余 warning 并脱敏', async (context) => {
  const { configureTrustedPublishers } = await import('../configure-trusted-publishers.mjs');
  const output = [];
  context.mock.method(process.stderr, 'write', (chunk) => { output.push(chunk); return true; });
  await configureTrustedPublishers({ model: { packages: [{ name: '@example/pkg' }] },
    policy: { environment: 'npm', workflow: 'release.yml', githubRepository: 'example/project', npmTrustVersion: '11.19.1' },
    execute: () => ({ status: 0, stderr: 'npm warn user option npm_secret\n',
      stdout: JSON.stringify([{ type: 'github', environment: 'npm', file: 'release.yml', repository: 'example/project', permissions: ['createPackage'] }]) }),
  });
  assert.match(output.join(''), /npm warn user option \[REDACTED\]/u);
});

test('npm 子进程只去掉 pnpm 注入噪音并保留认证与网络设置', async () => {
  const { createNpmEnvironment, createPublicConsumerEnvironment } = await import('../release-environment.mjs')
    .catch((error) => assert.fail(`缺少环境隔离实现：${error.code}`));
  const env = { PATH: 'path', NPM_CONFIG_OTP: '123456', NODE_AUTH_TOKEN: 'npm_secret',
    npm_config_package_extensions: 'extension', npm_config__example_registry: 'registry',
    npm_config_strict_peer_dependencies: 'true', npm_config_npm_globalconfig: 'path',
    npm_config_userconfig: 'user', HTTPS_PROXY: 'proxy', NODE_EXTRA_CA_CERTS: 'cert',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', npm_config_unknown_option: 'keep-warning',
  };
  const npm = createNpmEnvironment(env);
  assert.equal(npm.NPM_CONFIG_OTP, '123456');
  assert.equal(npm.NODE_AUTH_TOKEN, 'npm_secret');
  assert.equal(npm.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'oidc');
  assert.equal(npm.npm_config_unknown_option, 'keep-warning');
  assert.equal(npm.npm_config_package_extensions, undefined);
  assert.equal(npm.npm_config__example_registry, undefined);
  const consumer = createPublicConsumerEnvironment(env, 'empty-config');
  assert.equal(consumer.NODE_AUTH_TOKEN, undefined);
  assert.equal(consumer.NPM_CONFIG_OTP, undefined);
  assert.equal(consumer.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(consumer.npm_config_userconfig, undefined);
  assert.equal(consumer.NPM_CONFIG_USERCONFIG, 'empty-config');
  assert.equal(consumer.HTTPS_PROXY, 'proxy');
  assert.equal(consumer.NODE_EXTRA_CA_CERTS, 'cert');
  assert.equal(env.NPM_CONFIG_OTP, '123456');
});

test('已配置 Trusted Publisher 只回读，不再次请求 OTP', async () => {
  const { configureTrustedPublishers } = await import('../configure-trusted-publishers.mjs');
  const policy = { environment: 'npm', workflow: 'release.yml', githubRepository: 'example/project', npmTrustVersion: '11.19.1' };
  const result = await configureTrustedPublishers({ model: { packages: [{ name: '@example/pkg' }] }, policy,
    readOtp: async () => assert.fail('已有配置不应读取 OTP'),
    execute: (invocation) => {
      assert.ok(invocation.args.includes('list'));
      return { status: 0, stdout: JSON.stringify([{ type: 'github', environment: 'npm', file: 'release.yml', repository: 'example/project', permissions: ['createPackage'] }]) };
    },
  });
  assert.deepEqual(result, [{ action: 'unchanged', name: '@example/pkg' }]);
});

for (const readbackMatches of [true, false]) test(
  `网页 trust 写入连接终端且必须另行回读确认：${readbackMatches}`, async () => {
    const { configureTrustedPublishers } = await import('../configure-trusted-publishers.mjs');
    const policy = { environment: 'npm', workflow: 'release.yml',
      githubRepository: 'example/project', npmTrustVersion: '11.19.1' };
    let written = false;
    const actions = [];
    const operation = configureTrustedPublishers({ model: { packages: [{ name: '@example/pkg' }] },
      policy, authMode: 'web', input: { isTTY: true }, output: { isTTY: true },
      environment: { PATH: 'fixture', npm_config_otp: '123456' },
      readOtp: () => assert.fail('网页 trust 不应读取 OTP'),
      execute: (invocation, environment, { stdio } = {}) => {
        assert.equal(environment.npm_config_otp, undefined);
        if (invocation.args.includes('list')) {
          assert.deepEqual(stdio, ['ignore', 'pipe', 'pipe']);
          assert.ok(invocation.args.includes('--json'));
          actions.push('list');
          return { status: 0, stdout: JSON.stringify(written && readbackMatches
            ? [{ type: 'github', environment: 'npm', file: 'release.yml', repository: 'example/project', permissions: ['createPackage'] }] : []) };
        }
        assert.equal(stdio, 'inherit');
        assert.ok(invocation.args.includes('--auth-type=web'));
        assert.ok(invocation.args.includes('--browser=false'));
        assert.ok(invocation.args.includes('--otp='));
        assert.ok(invocation.args.includes('--json=false'));
        assert.equal(invocation.args.includes('--json'), false);
        actions.push('write'); written = true;
        return { status: 0, stdout: null, stderr: null };
      },
    });
    if (readbackMatches) assert.deepEqual(await operation, [{ action: 'configured', name: '@example/pkg' }]);
    else await assert.rejects(operation, /trusted publisher verification failed/iu);
    assert.deepEqual(actions, ['list', 'write', 'list']);
  });

test('网页模式已有 trust 时只回读，不要求交互终端', async () => {
  const { configureTrustedPublishers } = await import('../configure-trusted-publishers.mjs');
  const result = await configureTrustedPublishers({ model: { packages: [{ name: '@example/pkg' }] },
    policy: { environment: 'npm', workflow: 'release.yml', githubRepository: 'example/project' },
    authMode: 'web', input: { isTTY: false }, output: { isTTY: false },
    readOtp: () => assert.fail('已有 trust 不应认证'),
    execute: (invocation) => {
      assert.ok(invocation.args.includes('list'));
      return { status: 0, stdout: JSON.stringify([{ type: 'github', environment: 'npm',
        file: 'release.yml', repository: 'example/project', permissions: ['createPackage'] }]) };
    },
  });
  assert.deepEqual(result, [{ action: 'unchanged', name: '@example/pkg' }]);
});
