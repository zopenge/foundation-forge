import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { readReleaseReport } from '../release-report.mjs';
import { captureReleaseOutput } from './helpers/release-output.mjs';

const implementation = () => import('../release-bootstrap.mjs').catch((error) => assert.fail(`缺少 bootstrap 编排：${error.code}`));
const binding = { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64), registry: 'https://registry.npmjs.org', pnpmVersion: '10.33.2' };
const setup = async (context) => {
  const output = captureReleaseOutput(context);
  await mkdir(resolve('.tmp', 'release-tests'), { recursive: true });
  const repositoryRoot = await mkdtemp(resolve('.tmp', 'release-tests', 'bootstrap-'));
  context.after(() => rm(repositoryRoot, { force: true, recursive: true }));
  return { output, model: { repositoryRoot, packages: [{ name: 'fixture', version: '1.0.0-rc.0', workspaceDependencies: [] }] }, policy: {},
    readMetadata: async () => undefined, readState: () => {}, verifyTags: async () => {},
    captureBinding: async () => binding, waitForRegistry: async () => {} };
};

test('没有首次发布候选时不读取 OTP 也不执行 publish', async (context) => {
  const { runBootstrapRelease } = await implementation();
  const options = await setup(context);
  await runBootstrapRelease({ ...options,
    readMetadata: async () => ({ versions: { '1.0.0-rc.0': {} } }),
    readOtp: async () => assert.fail('不应请求 OTP'), publish: async () => assert.fail('不应 publish'),
  });
});

test('历史 tag 或源码预检失败发生在 OTP 和 publish 之前', async (context) => {
  const { runBootstrapRelease } = await implementation();
  const options = await setup(context);
  await assert.rejects(runBootstrapRelease({ ...options,
    verifyTags: async () => { throw new Error('historical tag missing'); },
    readOtp: async () => assert.fail('不应请求 OTP'), publish: async () => assert.fail('不应 publish'),
  }), /historical tag missing/u);
});

test('候选包存在指向其他 commit 的 tag 时在 OTP 前拒绝发布', async (context) => {
  const { runBootstrapRelease } = await implementation();
  const options = await setup(context);
  await assert.rejects(runBootstrapRelease({ ...options, verifyTags: undefined,
    readTag: async () => 'c'.repeat(40),
    readOtp: async () => assert.fail('冲突 tag 不应读取 OTP'),
    publish: async () => assert.fail('冲突 tag 不应 publish'),
  }), /BOOTSTRAP_TAG_CONFLICT/u);
});

test('publish 成功而 trust 失败时保留可续验报告', async (context) => {
  const { runBootstrapRelease } = await implementation();
  const options = await setup(context);
  await assert.rejects(runBootstrapRelease({ ...options, readOtp: async () => '123456',
    publish: async ({ onPublishState }) => {
      await onPublishState(options.model.packages[0], 'started');
      await onPublishState(options.model.packages[0], 'succeeded');
    },
    configure: async () => { throw new Error('trust failed'); },
    verify: async () => assert.fail('不应继续验证'),
  }), /trust failed/u);
  const directory = resolve(options.model.repositoryRoot, '.tmp', 'release');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const report = await readReleaseReport(options.model.repositoryRoot, resolve(directory, files[0]));
  assert.equal(report.targets[0].publish, 'succeeded');
  assert.equal(report.stages.trustedPublisher, 'failed');
  assert.equal(report.stages.consumer, 'pending');
  assert.match(options.output(), /发布后仍有未完成阶段：fixture@1\.0\.0-rc\.0/u);
  assert.match(options.output(), /pnpm release:resume --report/u);
});

test('网页 bootstrap 通过预检后交给 npm 授权，不读取终端 OTP', async (context) => {
  const { runBootstrapRelease } = await implementation();
  const options = await setup(context);
  const actions = [];
  const result = await runBootstrapRelease({ ...options, authMode: 'web',
    input: { isTTY: true }, output: { isTTY: true },
    environment: { PATH: 'fixture', NPM_CONFIG_OTP: '123456' },
    readOtp: () => assert.fail('网页模式不应读取 OTP'),
    publish: async ({ authMode, environment, onPublishState }) => {
      assert.equal(authMode, 'web');
      assert.deepEqual(environment, { PATH: 'fixture' });
      actions.push('publish');
      await onPublishState(options.model.packages[0], 'started');
      await onPublishState(options.model.packages[0], 'succeeded');
    },
    configure: async ({ authMode }) => { assert.equal(authMode, 'web'); actions.push('trust'); },
    verify: async () => { actions.push('verify'); return 'verified'; },
  });
  assert.equal(result, 'verified');
  assert.deepEqual(actions, ['publish', 'trust', 'verify']);
});

test('网页 bootstrap 在无终端时拒绝写入，且仍先做源码预检', async (context) => {
  const { runBootstrapRelease } = await implementation();
  const options = await setup(context);
  let checked = false;
  await assert.rejects(runBootstrapRelease({ ...options, authMode: 'web',
    input: { isTTY: false }, output: { isTTY: true },
    readState: () => { checked = true; },
    readOtp: () => assert.fail('不应降级到 OTP'),
    publish: () => assert.fail('无终端不应 publish'),
  }), /WEB_AUTH_REQUIRES_TTY/u);
  assert.equal(checked, true);
});

test('普通自动发布不能启用网页交互或越过首次发布门禁', async (context) => {
  const { publishIfNeeded } = await import('../publish-if-needed.mjs');
  const { model } = await setup(context);
  context.mock.method(globalThis, 'fetch', () => assert.fail('认证模式校验前不应访问 registry'));
  await assert.rejects(publishIfNeeded({ authMode: 'web', bootstrap: false, model,
    policy: { registry: 'http://127.0.0.1' } }),
    /WEB_AUTH_BOOTSTRAP_ONLY/u);
});
