import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { runCaptured, runCleanPackageConsumer } from '../package-consumer-runner.mjs';
import { createPackageManagerInvocation } from '../package-manager-command.mjs';
import { createPublicConsumerEnvironment } from '../release-environment.mjs';
import { installRegistryConsumer, runInstallCommand } from '../release-install.mjs';
import { createPropagationBudget } from '../release-propagation.mjs';
import { verifyRegistryPackages } from '../release-registry.mjs';
import { serveFetchRegistry } from './helpers/fetch-registry-server.mjs';
import { captureReleaseOutput } from './helpers/release-output.mjs';
import { discoverTestProcessSupervisor } from '../test-process-runner.mjs';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';

const fixture = async (context) => {
  captureReleaseOutput(context);
  await mkdir(resolve('.tmp', 'release-tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp', 'release-tests', 'real-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const servePackage = async (context, root, initialFailure = '404') => {
  const name = `@release-fixture/${root.split(/[\\/]/u).at(-1).toLowerCase()}`;
  const source = resolve(root, 'source');
  await mkdir(source);
  await writeFile(resolve(source, 'package.json'), JSON.stringify({ name, version: '1.0.0-rc.0', type: 'module',
    exports: './index.js', files: ['index.js'],
  }));
  await writeFile(resolve(source, 'index.js'), 'export const value = 42;\n');
  await writeFile(resolve(source, 'pnpm-workspace.yaml'), 'packages: []\n');
  const pack = createPackageManagerInvocation('pnpm', ['pack', '--pack-destination', root]);
  await runCaptured(pack.command, pack.args, { cwd: source });
  const filename = `${name.slice(1).replace('/', '-')}-1.0.0-rc.0.tgz`;
  const bytes = await readFile(resolve(root, filename));
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const requests = [];
  let installRequests = 0;
  const registry = await serveFetchRegistry(context, (request, response) => {
    const install = request.headers['user-agent']?.startsWith('pnpm/');
    requests.push({ url: request.url, accept: request.headers.accept, authorization: request.headers.authorization, install });
    if (request.url === '/package.tgz') { response.end(bytes); return; }
    if (decodeURIComponent(request.url) !== `/${name}`) { response.writeHead(404); response.end('{}'); return; }
    if (install && ++installRequests === 1) {
      if (initialFailure === 'reset') { request.socket.destroy(); return; }
      response.writeHead(404); response.end('{}'); return;
    }
    const metadata = { name, 'dist-tags': { next: '1.0.0-rc.0', latest: '1.0.0-rc.0' },
      versions: { '1.0.0-rc.0': { name, version: '1.0.0-rc.0', type: 'module',
        dist: { tarball: `${registry}/package.tgz`, integrity },
      } },
    };
    response.setHeader('content-type', request.headers.accept?.includes('application/vnd.npm.install-v1+json')
      ? 'application/vnd.npm.install-v1+json' : 'application/json');
    response.end(JSON.stringify(metadata));
  });
  await writeFile(resolve(root, '.npmrc'), `registry=${registry}/\n`);
  await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\nautoInstallPeers: false\n');
  await writeFile(resolve(source, 'package.verify.json'), '{"browserExports": []}\n');
  await mkdir(resolve(source, 'package-consumer'));
  await writeFile(resolve(source, 'package-consumer', 'verify.mjs'),
    `import { value } from '${name}';\nif (value !== 42) throw new Error('wrong tarball');\n`);
  return { name, registry, requests, packageValue: { name, version: '1.0.0-rc.0',
    packageRoot: source, exports: [{ specifier: name, subpath: '.', importTarget: './index.js' }], bins: [], workspaceDependencies: [],
  } };
};

test('registry 夹具避开 Fetch 禁止端口后仍能读取真实元数据', { timeout: 45_000 }, async (context) => {
  const root = await fixture(context);
  const address = Server.prototype.address;
  let firstAddress = true;
  // 只控制系统分配地址的边界；实际监听继续使用端口 0，不占用固定端口。
  context.mock.method(Server.prototype, 'address', function (...args) {
    const actual = address.apply(this, args);
    if (firstAddress && actual !== null) {
      firstAddress = false;
      return { ...actual, port: 10080 };
    }
    return actual;
  });
  const { name, registry } = await servePackage(context, root);
  const response = await globalThis.fetch(`${registry}/${encodeURIComponent(name)}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).name, name);
  assert.notEqual(new URL(registry).port, '10080');
});

test('真实 pnpm 在元数据已通过后遇到首次 404，重试安装 tarball 并通过导入和 smoke', { timeout: 45_000 }, async (context) => {
  const root = await fixture(context);
  const { name, registry, requests, packageValue } = await servePackage(context, root);
  const stages = [];
  const verificationRoot = resolve(root, '.tmp', 'consumer-verification');
  const result = await verifyRegistryPackages({
    model: { repositoryRoot: root, packages: [packageValue,
      { name: 'unrelated-not-published', version: '9.0.0', workspaceDependencies: [] }] },
    mode: 'bootstrap', packageNames: [name], policy: { registry, pollTimeoutMilliseconds: 30_000 },
    verificationRoot, resolveCommit: async () => 'a'.repeat(40),
    budget: createPropagationBudget({ timeoutMilliseconds: 30_000, intervalMilliseconds: 1 }),
    onEvent: async (event) => stages.push(event),
  });
  assert.equal(result.length, 1);
  assert.ok(requests.filter(({ install, url }) => install && !url.endsWith('.tgz')).length >= 2);
  assert.ok(requests.some(({ accept }) => accept?.includes('application/vnd.npm.install-v1+json')));
  assert.ok(requests.every(({ authorization }) => authorization === undefined));
  assert.deepEqual(stages.at(-1), { stage: 'consumer', state: 'succeeded' });
  await assert.rejects(readFile(resolve(verificationRoot, 'consumer', 'package.json')), { code: 'ENOENT' });
});

test('真实 pnpm 包装的首次元数据断连会重试并成功安装', { timeout: 45_000 }, async (context) => {
  const root = await fixture(context);
  const { name, registry, requests, packageValue } = await servePackage(context, root, 'reset');
  await verifyRegistryPackages({ model: { repositoryRoot: root, packages: [packageValue] },
    mode: 'bootstrap', packageNames: [name], policy: { registry, pollTimeoutMilliseconds: 30_000 },
    verificationRoot: resolve(root, '.tmp', 'verification'), resolveCommit: async () => 'a'.repeat(40),
    budget: createPropagationBudget({ timeoutMilliseconds: 30_000, intervalMilliseconds: 1 }),
  });
  assert.ok(requests.filter(({ install, url }) => install && !url.endsWith('.tgz')).length >= 2);
});

test('安装阶段超时会回收实际子进程，耗尽预算后不再重试', { timeout: 10_000 }, async (context) => {
  const root = await fixture(context);
  const model = await discoverWorkspacePackageModel({ repositoryRoot: resolve(import.meta.dirname, '../..') });
  const { reader } = await discoverTestProcessSupervisor({ packages: model.packages });
  let child, captured;
  await assert.rejects(runInstallCommand({ cwd: root, env: process.env, timeoutMilliseconds: 500,
    spawnCommand: (...args) => {
      child = spawn(...args);
      assert.ok(child.pid);
      captured = reader.readIdentity({ pid: child.pid, signal: globalThis.AbortSignal.timeout(5_000) })
        .then(value => ({ value }), error => ({ error }));
      return child;
    },
    invocation: { command: process.execPath, args: ['--input-type=module', '-e', 'setInterval(()=>{},1000);'] },
  }), { code: 'CONSUMER_INSTALL_TIMEOUT' });
  assert.ok(child); const pid = child.pid;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  const observed = await captured;
  assert.ifError(observed.error); assert.equal(observed.value.status, 'FOUND');
  const after = await reader.readIdentity({ pid, signal: globalThis.AbortSignal.timeout(5_000) });
  // 必须确认原实例退出；其他worker复用同一PID不能被误判为本次安装泄漏。
  assert.ok(after.status === 'ABSENT' || after.identity.startToken !== observed.value.identity.startToken);
});

test('真实安装成功后的失败 smoke 不触发安装重试', { timeout: 45_000 }, async (context) => {
  const root = await fixture(context);
  const { registry, packageValue, name } = await servePackage(context, root);
  await writeFile(resolve(root, 'source', 'package-consumer', 'verify.mjs'), "throw new Error('smoke regression');\n");
  const emptyConfig = resolve(root, 'empty.npmrc');
  await writeFile(emptyConfig, '');
  const env = createPublicConsumerEnvironment(process.env, emptyConfig);
  const budget = createPropagationBudget({ timeoutMilliseconds: 30_000, intervalMilliseconds: 1 });
  let attempts = 0;
  await assert.rejects(runCleanPackageConsumer({ consumerRoot: resolve(root, 'consumer'),
    model: { repositoryRoot: root, packages: [{ ...packageValue,
      verification: { consumerScript: resolve(root, 'source', 'package-consumer', 'verify.mjs') } }] },
    references: new Map([[name, packageValue.version]]), env,
    install: ({ cwd }) => installRegistryConsumer({ cwd, env, budget, confirmedNames: new Set([name]),
      run: async (options) => { attempts += 1; return runInstallCommand(options); },
    }),
  }), /smoke regression/u);
  assert.equal(attempts, 2);
  assert.ok(registry.startsWith('http://127.0.0.1:'));
});
