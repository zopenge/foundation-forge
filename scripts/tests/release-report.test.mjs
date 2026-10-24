import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const implementation = () => import('../release-report.mjs').catch((error) => {
  assert.fail(`缺少发布报告实现：${error.code}`);
});
const binding = { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64),
  registry: 'https://registry.npmjs.org', pnpmVersion: '10.33.2' };
const targets = [{ name: '@example/pkg', version: '1.0.0-rc.0' }];
const fixture = async (context) => {
  await mkdir(resolve('.tmp', 'release-tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'release-tests', 'report-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('阶段失败保存已发布结果、脱敏首错和精确续验目标', async (context) => {
  const { createReleaseReport, writeReleaseReport, readReleaseReport, recordReleaseFailure } = await implementation();
  const root = await fixture(context);
  const report = createReleaseReport({ binding, mode: 'bootstrap', targets, packages: targets });
  report.targets[0].publish = 'succeeded';
  report.stages.trustedPublisher = 'succeeded';
  recordReleaseFailure(report, 'consumer', Object.assign(new Error('npm_secret authorization: Bearer hidden otp 123456'), { code: 'FETCH_FAILED' }));
  const path = await writeReleaseReport(root, report);
  const restored = await readReleaseReport(root, path);
  assert.equal(restored.targets[0].publish, 'succeeded');
  assert.equal(restored.stages.trustedPublisher, 'succeeded');
  assert.equal(restored.stages.consumer, 'failed');
  assert.equal(restored.firstError.code, 'FETCH_FAILED');
  assert.equal(restored.targets[0].version, '1.0.0-rc.0');
  assert.doesNotMatch(await readFile(path, 'utf8'), /npm_secret|hidden|123456/u);
  recordReleaseFailure(restored, 'consumer', new Error('later error'));
  assert.equal(restored.firstError.code, 'FETCH_FAILED');
});

test('续验拒绝源码变化、目标变化、未知发布结果及损坏报告', async (context) => {
  const { createReleaseReport, writeReleaseReport, readReleaseReport, assertResumeBinding } = await implementation();
  const root = await fixture(context);
  const report = createReleaseReport({ binding, mode: 'bootstrap', targets, packages: targets });
  report.targets[0].publish = 'succeeded';
  assert.doesNotThrow(() => assertResumeBinding(report, { binding, targets, packages: targets }));
  assert.throws(() => assertResumeBinding(report, { binding: { ...binding, commit: 'c'.repeat(40) }, targets, packages: targets }), /SOURCE_CHANGED/u);
  assert.throws(() => assertResumeBinding(report, { binding, targets: [{ ...targets[0], version: '1.0.0-rc.1' }], packages: targets }), /TARGETS_CHANGED/u);
  report.targets[0].publish = 'unknown';
  assert.throws(() => assertResumeBinding(report, { binding, targets, packages: targets }), /PUBLISH_UNCONFIRMED/u);
  const path = await writeReleaseReport(root, report);
  const value = JSON.parse(await readFile(path, 'utf8'));
  value.targets[0].version = '9.0.0';
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(readReleaseReport(root, path), /REPORT_INVALID/u);
  await assert.rejects(readReleaseReport(root, resolve(root, 'outside.json')), /REPORT_PATH/u);
});

test('独立 bootstrap 验证的 pending 报告可以续验且不覆盖实际发布报告', async (context) => {
  const { createReleaseReport, writeReleaseReport, assertResumeBinding } = await implementation();
  const root = await fixture(context);
  const verification = createReleaseReport({ binding, mode: 'bootstrap', kind: 'verification', targets, packages: targets });
  verification.stages.trustedPublisher = 'not-required';
  assert.doesNotThrow(() => assertResumeBinding(verification, { binding, targets, packages: targets }));
  const publishing = createReleaseReport({ binding, mode: 'bootstrap', kind: 'bootstrap', targets, packages: targets });
  publishing.targets[0].publish = 'unknown';
  assert.notEqual(await writeReleaseReport(root, verification), await writeReleaseReport(root, publishing));
  assert.throws(() => assertResumeBinding(publishing, { binding, targets, packages: targets }), /PUBLISH_UNCONFIRMED/u);
});

test('网页认证失败报告不保留授权链接、长 OTP 或异常码中的凭据', async (context) => {
  const { createReleaseReport, writeReleaseReport, recordReleaseFailure } = await implementation();
  const root = await fixture(context);
  const report = createReleaseReport({ binding, mode: 'bootstrap', targets, packages: targets });
  recordReleaseFailure(report, 'trustedPublisher', Object.assign(new Error([
    'https://www.npmjs.com/auth/cli/auth-fixture',
    'https://www.npmjs.com/login?next=/login/cli/login-fixture',
    'https://registry.npmjs.org/-/v1/login/done/done-fixture',
    'otp 1234567890123456',
  ].join(' ')), { code: 'npm_code_fixture' }));
  const path = await writeReleaseReport(root, report);
  assert.doesNotMatch(await readFile(path, 'utf8'),
    /auth-fixture|login-fixture|done-fixture|1234567890123456|npm_code_fixture/u);
  assert.equal(report.firstError.code, '[REDACTED]');
});

test('npm JSON 错误中的 done URL 和转义换行不会泄漏授权标识或吞掉后文', async (context) => {
  const { createReleaseReport, writeReleaseReport, recordReleaseFailure } = await implementation();
  const root = await fixture(context);
  const report = createReleaseReport({ binding, mode: 'bootstrap', targets, packages: targets });
  recordReleaseFailure(report, 'trustedPublisher', new Error(JSON.stringify({ error: {
    code: 'EOTP',
    detail: 'https://www.npmjs.com/auth/cli/auth-fixture\nAfter authenticating',
    doneUrl: 'https://registry.npmjs.org/-/v1/done?authId=done-fixture',
  } })));
  const text = await readFile(await writeReleaseReport(root, report), 'utf8');
  assert.doesNotMatch(text, /auth-fixture|done-fixture/u);
  assert.match(text, /After authenticating/u);
});
