import assert from 'node:assert/strict';
import test from 'node:test';

import { configureTrustedPublishers } from '../configure-trusted-publishers.mjs';

const policy = { environment: 'npm', workflow: 'release.yml',
  githubRepository: 'example/project', npmTrustVersion: '11.19.1' };
const matching = { type: 'github', environment: 'npm', file: 'release.yml',
  repository: 'example/project', permissions: ['createPackage'] };
const options = { model: { packages: [{ name: '@example/pkg' }] }, policy,
  authMode: 'web', input: { isTTY: true }, output: { isTTY: true },
  environment: { PATH: 'fixture', npm_config_otp: '123456' },
  readOtp: () => assert.fail('网页验证不读取 OTP') };
const challenge = { status: 1, stdout: JSON.stringify({ error: { code: 'EOTP' } }),
  stderr: 'npm notice fixture warning\nnpm error code EOTP\n' };

for (const afterWrite of [false, true]) test(
  `网页配置读取遇到 EOTP 时连接真实终端并独立回读：写入后=${afterWrite}`, async (context) => {
    const actions = [];
    const warnings = [];
    let captured = 0;
    context.mock.method(process.stderr, 'write', (chunk) => { warnings.push(chunk); return true; });
    const result = await configureTrustedPublishers({ ...options,
      execute: (invocation, environment, { stdio }) => {
        assert.equal(environment.npm_config_otp, undefined);
        if (!invocation.args.includes('list')) {
          actions.push('write');
          assert.equal(stdio, 'inherit');
          return { status: 0 };
        }
        if (stdio === 'inherit') {
          actions.push('authorize-read');
          assert.ok(invocation.args.includes('--auth-type=web'));
          assert.ok(invocation.args.includes('--browser=false'));
          assert.ok(invocation.args.includes('--otp='));
          assert.ok(invocation.args.includes('--json=false'));
          return { status: 0 };
        }
        actions.push('read');
        assert.deepEqual(stdio, ['ignore', 'pipe', 'pipe']);
        captured += 1;
        if (afterWrite && captured === 1) return { status: 0, stdout: '' };
        if (captured === (afterWrite ? 2 : 1)) return challenge;
        return { status: 0, stdout: JSON.stringify([matching]) };
      },
    });
    assert.deepEqual(result, [{ action: afterWrite ? 'configured' : 'unchanged', name: '@example/pkg' }]);
    assert.deepEqual(actions, afterWrite
      ? ['read', 'write', 'read', 'authorize-read', 'read']
      : ['read', 'authorize-read', 'read']);
    assert.match(warnings.join(''), /npm notice fixture warning/u);
  });

test('网页验证后的 JSON 回读仍需认证时有界失败，不写入配置', async () => {
  const actions = [];
  await assert.rejects(configureTrustedPublishers({ ...options,
    execute: (invocation, environment, { stdio }) => {
      assert.ok(invocation.args.includes('list'));
      actions.push(stdio === 'inherit' ? 'authorize-read' : 'read');
      return stdio === 'inherit' ? { status: 0 } : challenge;
    },
  }), /EOTP/u);
  assert.deepEqual(actions, ['read', 'authorize-read', 'read']);
});

test('读取需要网页认证但没有真实终端时明确失败', async () => {
  let calls = 0;
  await assert.rejects(configureTrustedPublishers({ ...options,
    input: { isTTY: false }, output: { isTTY: false },
    execute: () => { calls += 1; return challenge; },
  }), /WEB_AUTH_REQUIRES_TTY/u);
  assert.equal(calls, 1);
});

for (const status of [1, null]) test(`网页授权退出 ${String(status)} 后不回读或写入`, async () => {
  const actions = [];
  await assert.rejects(configureTrustedPublishers({ ...options,
    execute: (invocation, environment, { stdio }) => {
      assert.ok(invocation.args.includes('list'));
      actions.push(stdio === 'inherit' ? 'authorize-read' : 'read');
      return stdio === 'inherit' ? { status } : challenge;
    },
  }), /npm trust exited with code/u);
  assert.deepEqual(actions, ['read', 'authorize-read']);
});

for (const stdout of ['', '{"error":{"code":"EOTP"']) test(
  `仅 stderr 的 EOTP 文本不足以触发网页认证：stdout=${JSON.stringify(stdout)}`, async () => {
    let calls = 0;
    await assert.rejects(configureTrustedPublishers({ ...options,
      execute: () => { calls += 1; return { ...challenge, stdout }; },
    }), /EOTP/u);
    assert.equal(calls, 1);
  });

for (const code of ['E401', 'E403', 'E500']) test(`读取 ${code} 不触发网页认证或写入`, async () => {
  let calls = 0;
  await assert.rejects(configureTrustedPublishers({ ...options,
    execute: () => { calls += 1; return { status: 1,
      stdout: JSON.stringify({ error: { code } }), stderr: `npm error code ${code}\n` }; },
  }), new RegExp(code, 'u'));
  assert.equal(calls, 1);
});

test('默认模式读取遇到 EOTP 时只通过掩码输入取得 OTP', async () => {
  let prompts = 0;
  let calls = 0;
  await configureTrustedPublishers({ ...options, authMode: 'otp', environment: { PATH: 'fixture' },
    readOtp: async () => { prompts += 1; return '123456'; },
    execute: (invocation, environment, { stdio }) => {
      calls += 1;
      assert.ok(invocation.args.includes('list'));
      assert.deepEqual(stdio, ['ignore', 'pipe', 'pipe']);
      if (calls === 1) return challenge;
      assert.equal(environment.NPM_CONFIG_OTP, '123456');
      assert.equal(invocation.args.includes('123456'), false);
      return { status: 0, stdout: JSON.stringify([matching]) };
    },
  });
  assert.equal(prompts, 1);
  assert.equal(calls, 2);
});
