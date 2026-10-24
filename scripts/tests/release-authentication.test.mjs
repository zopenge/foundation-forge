import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const implementation = () => import('../release-authentication.mjs').catch((error) =>
  assert.fail(`缺少发布认证入口：${error.code}`));

test('认证选项默认 OTP，显式网页选项保留其他入口参数', async () => {
  const { parseReleaseAuthenticationArguments: parse } = await implementation();
  assert.deepEqual(parse([]), { authMode: 'otp', args: [] });
  assert.deepEqual(parse(['--report', 'report.json', '--auth-mode', 'web']),
    { authMode: 'web', args: ['--report', 'report.json'] });
  assert.deepEqual(parse(['--auth-mode', 'otp', '--package', '@example/pkg']),
    { authMode: 'otp', args: ['--package', '@example/pkg'] });
  for (const args of [['--auth-mode'], ['--auth-mode', '--report'],
    ['--auth-mode', 'legacy'], ['--auth-mode', 'web', '--auth-mode', 'otp']]) {
    assert.throws(() => parse(args), /auth-mode/u);
  }
});

test('网页认证不读取 OTP，保留连接配置且不修改原环境', async () => {
  const { readReleaseAuthentication } = await implementation();
  const environment = { PATH: 'path', NPM_CONFIG_OTP: '123456', npm_config_otp: '654321',
    NODE_AUTH_TOKEN: 'npm_fixture', HTTPS_PROXY: 'proxy', NODE_EXTRA_CA_CERTS: 'cert',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', npm_config_userconfig: 'user' };
  const result = await readReleaseAuthentication({ authMode: 'web', environment,
    input: { isTTY: true }, output: { isTTY: true },
    readOtp: () => assert.fail('网页模式不应读取终端 OTP') });
  assert.deepEqual(result, { PATH: 'path', NODE_AUTH_TOKEN: 'npm_fixture',
    HTTPS_PROXY: 'proxy', NODE_EXTRA_CA_CERTS: 'cert',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', npm_config_userconfig: 'user' });
  assert.equal(environment.NPM_CONFIG_OTP, '123456');
  assert.equal(environment.npm_config_otp, '654321');
});

test('网页认证必须同时连接真实终端输入和输出', async () => {
  const { readReleaseAuthentication } = await implementation();
  for (const [stdin, stdout] of [[false, false], [false, true], [true, false]]) {
    await assert.rejects(readReleaseAuthentication({ authMode: 'web',
      input: { isTTY: stdin }, output: { isTTY: stdout }, environment: {},
      readOtp: () => assert.fail('不应降级到 OTP') }), /WEB_AUTH_REQUIRES_TTY/u);
  }
});

test('默认 OTP 路径保留掩码读取入口并拒绝非法验证码', async () => {
  const { readReleaseAuthentication } = await implementation();
  let reads = 0;
  const result = await readReleaseAuthentication({ environment: { npm_config_otp: 'old' },
    readOtp: async () => { reads += 1; return '123456'; } });
  assert.deepEqual(result, { NPM_CONFIG_OTP: '123456' });
  assert.equal(reads, 1);
  await assert.rejects(readReleaseAuthentication({ environment: {},
    readOtp: async () => 'invalid' }), /exactly six digits/u);
});

test('网页 CLI 参数覆盖旧 OTP 和 JSON 设置，普通认证不改参数', async () => {
  const { npmAuthenticationArguments } = await implementation();
  assert.deepEqual(npmAuthenticationArguments('web'),
    ['--auth-type=web', '--browser=false', '--otp=', '--json=false']);
  assert.deepEqual(npmAuthenticationArguments('otp'), []);
  assert.throws(() => npmAuthenticationArguments('invalid'), /auth-mode/u);
});

for (const entry of ['bootstrap-publish.mjs', 'configure-trusted-publishers.mjs', 'resume-release.mjs']) {
  test(`${entry} 的真实入口在网络和认证前拒绝非法认证模式`, () => {
    const script = fileURLToPath(new URL(`../${entry}`, import.meta.url));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      const [entry, ...args] = process.argv.slice(1);
      process.argv = [process.execPath, entry, ...args];
      globalThis.fetch = async () => { throw new Error('UNEXPECTED_REGISTRY_ACCESS'); };
      await import(pathToFileURL(entry));
    `, script, '--auth-mode', 'invalid'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported --auth-mode/u);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_REGISTRY_ACCESS/u);
  });
}
