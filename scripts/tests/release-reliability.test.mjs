import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { waitForPackageVersion } from '../release-registry.mjs';
import * as registry from '../release-registry.mjs';
import { runCleanPackageConsumer } from '../package-consumer-runner.mjs';
import { createPropagationBudget } from '../release-propagation.mjs';

const integrity = `sha512-${createHash('sha512').update('package').digest('base64')}`;
const metadata = {
  'dist-tags': { next: '1.0.0-rc.0' },
  versions: { '1.0.0-rc.0': { dist: { integrity, tarball: 'https://registry.example/package.tgz' } } },
};
const response = (status, json = metadata, bytes = 'package') => ({
  ok: status >= 200 && status < 300, status,
  json: async () => json, arrayBuffer: async () => Buffer.from(bytes),
});
const options = {
  mode: 'bootstrap', name: '@example/package', registry: 'https://registry.example', version: '1.0.0-rc.0',
};
const registryOptions = () => {
  let time = 0;
  return { ...options, budget: createPropagationBudget({ timeoutMilliseconds: 80, intervalMilliseconds: 10,
    now: () => time, sleep: async (milliseconds) => { time += milliseconds; },
  }) };
};

test('完整元数据可用时仍等待 pnpm 精简视图及其 scoped 请求路径', async () => {
  const requests = [];
  let abbreviatedAttempts = 0;
  const result = await waitForPackageVersion({ ...registryOptions(), fetch: async (url, init) => {
    requests.push({ url, accept: init?.headers?.accept });
    if (init?.headers?.accept?.includes('application/vnd.npm.install-v1+json')) {
      abbreviatedAttempts += 1;
      return response(abbreviatedAttempts === 1 ? 404 : 200);
    }
    return response(200);
  } });
  assert.equal(result.versionMetadata.dist.integrity, integrity);
  assert.equal(abbreviatedAttempts, 2);
  assert.ok(requests.some(({ url, accept }) => url === 'https://registry.example/@example%2Fpackage'
    && accept?.includes('application/vnd.npm.install-v1+json')));
});

test('registry 认证失败立即停止而非等待传播超时', async () => {
  let attempts = 0;
  await assert.rejects(waitForPackageVersion({ ...registryOptions(), fetch: async () => {
    attempts += 1;
    return response(403);
  } }), (error) => error.code === 'REGISTRY_HTTP_ERROR' && error.status === 403);
  assert.equal(attempts, 1);
});

test('tarball 完整性失败不会被当作可恢复传播错误', async () => {
  await assert.rejects(waitForPackageVersion({ ...registryOptions(),
    fetch: async () => response(200, metadata, 'corrupted'),
  }), (error) => error.code === 'REGISTRY_INTEGRITY_ERROR');
});

test('持续缺包时可控时钟仍严格耗尽传播预算', async () => {
  const controlled = registryOptions();
  let attempts = 0;
  await assert.rejects(waitForPackageVersion({ ...controlled, fetch: async () => {
    attempts += 1;
    return response(404);
  } }), (error) => error.code === 'REGISTRY_PROPAGATION_TIMEOUT' && error.cause.code === 'REGISTRY_PENDING');
  assert.equal(attempts, 8);
  assert.equal(controlled.budget.remaining(), 10);
});

test('指定包只选择传递依赖闭包且保留 workspace 拓扑顺序', () => {
  assert.equal(typeof registry.selectReleasePackages, 'function');
  const packages = [
    { name: 'core', version: '1.0.0', workspaceDependencies: [] },
    { name: 'unrelated', version: '9.0.0-rc.0', workspaceDependencies: [] },
    { name: 'provider', version: '2.0.0-rc.0', workspaceDependencies: ['core'] },
  ];
  const selected = registry.selectReleasePackages(packages, 'bootstrap', ['provider']);
  assert.deepEqual(selected.targets.map(({ name }) => name), ['provider']);
  assert.deepEqual(selected.packages.map(({ name }) => name), ['core', 'provider']);
  assert.throws(() => registry.selectReleasePackages(packages, 'bootstrap', ['missing']), /unknown/u);
});

test('安装与消费者检查分开执行，安装成功后 smoke 失败不重新安装', async (context) => {
  await mkdir(resolve('.tmp', 'release-tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'release-tests', 'consumer-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(resolve(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const smokeRoot = resolve(root, 'package-consumer');
  await mkdir(smokeRoot);
  await writeFile(resolve(smokeRoot, 'verify.mjs'), "throw new Error('intentional smoke failure');\n");
  let installs = 0;
  const phases = [];
  await assert.rejects(runCleanPackageConsumer({ consumerRoot: resolve(root, 'consumer'),
    model: { repositoryRoot: root, packages: [{
      name: 'fixture', packageRoot: root, exports: [], bins: [],
      verification: { consumerScript: resolve(smokeRoot, 'verify.mjs') },
    }] },
    references: new Map([['fixture', '1.0.0']]),
    install: async () => { installs += 1; },
    onPhase: (phase) => phases.push(phase),
  }), /intentional smoke failure/u);
  assert.equal(installs, 1);
  assert.deepEqual(phases, ['install', 'checks']);
});

test('传播预算跨阶段共享且按退避序列有界停止', async () => {
  let time = 0;
  const waits = [];
  const budget = createPropagationBudget({ timeoutMilliseconds: 30_000, now: () => time,
    sleep: async (ms) => { waits.push(ms); time += ms; },
  });
  let attempts = 0;
  await budget.retry(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('pending'), { code: 'REGISTRY_PENDING' });
  });
  await assert.rejects(budget.retry(async () => {
    throw Object.assign(new Error('pending'), { code: 'REGISTRY_PENDING' });
  }), { code: 'REGISTRY_PROPAGATION_TIMEOUT' });
  assert.deepEqual(waits, [2_000, 4_000, 2_000, 4_000, 8_000]);
  assert.equal(time, 20_000);
});
