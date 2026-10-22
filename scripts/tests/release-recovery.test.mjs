import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { createReleaseReport, writeReleaseReport, readReleaseReport } from '../release-report.mjs';
import { captureReleaseOutput } from './helpers/release-output.mjs';

const implementation = () => import('../release-recovery.mjs').catch((error) => assert.fail(`缺少续验编排：${error.code}`));
const binding = { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64),
  registry: 'https://registry.npmjs.org', pnpmVersion: '10.33.2' };
const packages = [{ name: '@example/pkg', version: '1.0.0-rc.0', workspaceDependencies: [] }];
const fixture = async (context) => {
  captureReleaseOutput(context);
  await mkdir(resolve('.tmp', 'release-tests'), { recursive: true });
  const repositoryRoot = await mkdtemp(resolve('.tmp', 'release-tests', 'recover-'));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  return { repositoryRoot, packages };
};

test('已发布后续验仅补齐 trust 与验证，拒绝已变化的 dist-tag', async (context) => {
  const { resumeRelease } = await implementation();
  const model = await fixture(context);
  const report = createReleaseReport({ binding, mode: 'bootstrap', kind: 'bootstrap', targets: packages, packages });
  report.targets[0].publish = 'succeeded';
  const path = await writeReleaseReport(model.repositoryRoot, report);
  const actions = [];
  const options = { model, policy: {}, reportPath: path,
    captureBinding: async () => binding,
    readTag: async () => binding.commit,
    readMetadata: async () => ({ 'dist-tags': { next: '1.0.0-rc.0' }, versions: { '1.0.0-rc.0': {} } }),
    configure: async () => { actions.push('trust'); },
    verify: async ({ onEvent }) => {
      actions.push('verify');
      await onEvent({ stage: 'registry', state: 'succeeded' });
      await onEvent({ stage: 'consumer', state: 'succeeded' });
    },
  };
  await resumeRelease(options);
  assert.deepEqual(actions, ['trust', 'verify']);
  assert.equal((await readReleaseReport(model.repositoryRoot, path)).stages.consumer, 'succeeded');
  actions.length = 0;
  await assert.rejects(resumeRelease({ ...options,
    readMetadata: async () => ({ 'dist-tags': { next: '1.0.0-rc.1' }, versions: { '1.0.0-rc.0': {} } }),
  }), /DIST_TAG_CHANGED/u);
  assert.deepEqual(actions, []);
});

test('验证失败保留已发布阶段并输出可读报告', async (context) => {
  const { runReportedVerification } = await implementation();
  const model = await fixture(context);
  const report = createReleaseReport({ binding, mode: 'bootstrap', kind: 'bootstrap', targets: packages, packages });
  report.targets[0].publish = 'succeeded';
  report.stages.trustedPublisher = 'succeeded';
  await assert.rejects(runReportedVerification({ model, policy: {}, report,
    captureBinding: async () => binding,
    verify: async ({ onEvent }) => {
      await onEvent({ stage: 'registry', state: 'succeeded' });
      await onEvent({ stage: 'consumer', state: 'started' });
      throw new Error('consumer failed');
    },
  }), /consumer failed/u);
  assert.equal(report.targets[0].publish, 'succeeded');
  assert.equal(report.stages.registry, 'succeeded');
  assert.equal(report.stages.consumer, 'failed');
  assert.equal(report.firstError.message, 'consumer failed');
});
