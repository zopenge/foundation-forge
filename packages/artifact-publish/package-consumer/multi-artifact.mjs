import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { bindArtifactOperation, createArtifactContentManifest, observeArtifactOperation, performArtifactOperation } from '@openge/forge-artifact-publish';
import { createCommandArtifactOperation } from '@openge/forge-artifact-publish/node';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { createLinuxOwnedProcessScopeProvider, createPosixProcessIdentityReader,
  createWindowsNativeProcessIdentityReader, createWindowsOwnedProcessScopeProvider } from '@openge/forge-process-control-node';
import { createClient, digest, startMultiFixture } from './multi-http.mjs';

// 此验证明确选择已支持的测试宿主，产品代码不自动选择 Provider。
function scopedRunner(onExit) {
  assert.ok(['win32', 'linux'].includes(process.platform) && process.arch === 'x64');
  const windows = process.platform === 'win32';
  const reader = windows ? createWindowsNativeProcessIdentityReader() : createPosixProcessIdentityReader();
  const runner = createNodeCommandRunner({ platform: windows ? 'win32' : 'posix',
    ownedScopeProvider: windows ? createWindowsOwnedProcessScopeProvider() : createLinuxOwnedProcessScopeProvider(),
    processControl: {
      async listProcesses({ pids, signal }) { const value = await reader.readIdentity({ pid: pids[0], signal }); return value.status === 'FOUND' ? [value.identity] : []; },
      async listTcpListeners() { return []; },
      async terminateProcess() { throw Error('owned operation must not use PID cleanup'); },
      async terminateProcessTree() { throw Error('owned operation must not use tree cleanup'); },
    }, terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 5_000,
    identityAcquisition: { timeoutMs: 10_000, pollIntervalMs: 20 } });
  const observer = event => { if (event.type === 'exited') onExit(event.result); };
  return { start: spec => runner.start(spec, observer), run: spec => runner.run(spec, observer) };
}

export async function verifyMultiArtifact() {
  const root = await mkdtemp(join(process.cwd(), 'multi-'));
  const fixture = await startMultiFixture(), journalClient = createClient(fixture.endpoint);
  const limits = { timeoutMilliseconds: 30_000, closeTimeoutMilliseconds: 5_000 };
  const commandFacts = [];
  // 此处仅捕获自有、无真实凭据的 fixture 命令，用于区分未派发与真正丢响应。
  const runner = scopedRunner(result => commandFacts.push({ exitCode: result.exitCode,
    terminationReason: result.terminationReason, diagnostics: result.diagnostics.map(value => value.code),
    scope: result.ownedScope?.reason, stderr: Buffer.from(result.stderr ?? []).toString('utf8').slice(0, 2048) }));
  const target = { provider: 'http-fixture', namespace: 'synthetic', endpoint: fixture.endpoint };
  const journal = {
    async load(id, context) { const result = await journalClient.call('/journal/' + id, { signal: context.signal }); assert.equal(result.status, 200); return JSON.parse(result.bytes) ?? undefined; },
    async compareAndSet(value, context) {
      const result = await journalClient.call('/journal/' + value.next.binding.requestId,
        { method: 'PUT', bytes: Buffer.from(JSON.stringify(value)), signal: context.signal });
      assert.ok([200, 409].includes(result.status)); return result.status === 200 ? 'stored' : 'conflict';
    },
  };
  const environment = { PUBLISH_SECRET: 'fixture-only', TEMP: root, TMP: root, TMPDIR: root };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'Path']) if (process.env[name] !== undefined) environment[name] = process.env[name];
  const commandPath = fileURLToPath(new URL('./multi-command.mjs', import.meta.url));
  async function prepare(kind, bytes, inputs, lose = false) {
    const path = join(root, kind + '.bin'); await writeFile(path, bytes);
    const content = await createArtifactContentManifest({ schemaVersion: 1, files: inputs.map(input => ({
      path: input.name, role: 'asset', byteLength: input.byteLength, sha256: input.sha256,
      responseHeaders: { 'content-type': 'application/octet-stream', 'cache-control': 'no-cache' },
    })) });
    const manifestPath = join(root, kind + '-content.json'); await writeFile(manifestPath, content.bytes);
    const observer = createClient(fixture.endpoint);
    const adapter = await createCommandArtifactOperation({ target, capability: 'deployment-create', runner,
      command: { command: process.execPath, cwd: root, args: [commandPath, fixture.endpoint, kind, path, digest(bytes), lose ? 'lose' : 'normal', manifestPath], environment },
      maxOutputBytesPerStream: 65_536, observationKey: kind + '-protocol-v1',
      observation: {
        async observe(binding, reference, context) {
          const response = await observer.call('/releases/' + binding.requestId, { signal: context.signal });
          assert.equal(response.status, 200); const value = JSON.parse(response.bytes);
          if (!value) return { state: 'absent', fingerprint: binding.fingerprint };
          assert.deepEqual(value.content, binding.content); assert.equal(value.fingerprint, binding.fingerprint);
          assert.equal(value.namespace, binding.target.namespace); assert.equal(value.kind, kind); assert.equal(value.id, reference ?? binding.requestId);
          if (kind !== 'runtime') {
            const expected = kind === 'image' ? Buffer.from(JSON.parse(bytes).manifest, 'base64') : bytes;
            const actual = await observer.call('/assets/' + binding.requestId, { signal: context.signal });
            assert.equal(actual.status, 200); assert.equal(digest(actual.bytes), digest(expected)); assert.equal(actual.bytes.length, expected.length);
            if (kind === 'image') {
              for (const descriptor of [JSON.parse(expected).config, ...JSON.parse(expected).layers]) {
                const blob = await observer.call('/v2/fixture/blobs/' + descriptor.digest.slice(7), { signal: context.signal });
                assert.equal(blob.status, 200); assert.equal(digest(blob.bytes), descriptor.digest.slice(7)); assert.equal(blob.bytes.length, descriptor.size);
              }
            }
          } else assert.equal(value.imageDigest, JSON.parse(bytes).imageDigest);
          return { state: value.state, fingerprint: binding.fingerprint, reference: value.id };
        }, close: () => observer.close(),
      } });
    const binding = await bindArtifactOperation({ requestId: kind + '-1', content: content.content, target,
      capability: 'deployment-create', configurationSha256: adapter.configurationSha256,
      inputs: [...inputs, { name: 'content-manifest.json', sha256: content.content.manifestSha256, byteLength: content.bytes.byteLength }] });
    return { adapter, binding };
  }
  try {
    const html = Buffer.from('<h1>independent static artifact</h1>');
    const staticInput = [{ name: 'static', sha256: digest(html), byteLength: html.length }];
    const first = await prepare('static', html, staticInput, true);
    await assert.rejects(performArtifactOperation(first.adapter, first.binding, journal, limits), { code: 'PROVIDER_FAILED' });
    const count = fixture.mutations();
    assert.equal(fixture.faults.length, 0, fixture.faults.map(error => String(error)).join('\n'));
    assert.equal(count, 1, JSON.stringify(commandFacts));
    const recovery = await prepare('static', html, staticInput, true);
    const staticReceipt = await observeArtifactOperation(recovery.adapter, recovery.binding, journal, limits);
    assert.equal(staticReceipt.outcome, 'succeeded'); assert.equal(staticReceipt.record.writeState, 'unknown');
    assert.equal(fixture.mutations(), count);

    const layer = Buffer.alloc(1024);
    const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: ['sha256:' + digest(layer)] }, config: {} }));
    const descriptor = (value, mediaType) => ({ mediaType, digest: 'sha256:' + digest(value), size: value.length });
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: descriptor(config, 'application/vnd.oci.image.config.v1+json'), layers: [descriptor(layer, 'application/vnd.oci.image.layer.v1.tar')] }));
    const archive = Buffer.from(JSON.stringify({ manifest: manifest.toString('base64'),
      blobs: [config, layer].map(value => ({ sha256: digest(value), bytes: value.toString('base64') })) }));
    const image = await prepare('image', archive, [{ name: 'manifest', sha256: digest(manifest), byteLength: manifest.length },
      { name: 'config', sha256: digest(config), byteLength: config.length }, { name: 'layer', sha256: digest(layer), byteLength: layer.length }]);
    const imageReceipt = await performArtifactOperation(image.adapter, image.binding, journal, limits);
    assert.equal(imageReceipt.outcome, 'succeeded'); assert.equal(imageReceipt.closure.status, 'closed');
    const runtimeBytes = Buffer.from(JSON.stringify({ imageDigest: 'sha256:' + digest(manifest) }));
    const inputs = [{ name: 'runtime', sha256: digest(runtimeBytes), byteLength: runtimeBytes.length }];
    const runtime = await prepare('runtime', runtimeBytes, inputs);
    assert.equal((await performArtifactOperation(runtime.adapter, runtime.binding, journal, limits)).outcome, 'pending');
    const before = fixture.mutations(); fixture.live();
    const runtimeRecovery = await prepare('runtime', runtimeBytes, inputs);
    const live = await observeArtifactOperation(runtimeRecovery.adapter, runtimeRecovery.binding, journal, limits);
    assert.equal(live.outcome, 'succeeded'); assert.equal(fixture.mutations(), before);
    const repeat = await prepare('runtime', runtimeBytes, inputs);
    await assert.rejects(performArtifactOperation(repeat.adapter, repeat.binding, journal, limits), { code: 'RECOVERY_REQUIRED' });
    assert.equal(fixture.mutations(), before);
    assert.equal(JSON.stringify(live).includes('fixture-only'), false);
    assert.equal(fixture.faults.length, 0);
    const overflow = await createCommandArtifactOperation({ target, capability: 'artifact-upload', runner,
      command: { command: process.execPath, cwd: root, args: ['-e', 'process.stdout.write("x".repeat(8192))'], environment },
      maxOutputBytesPerStream: 128, observationKey: 'overflow-v1',
      observation: { async observe() { throw Error('overflow must not be observed'); }, async close() { return { status: 'closed', activeRequests: 0 }; } } });
    const overflowBinding = await bindArtifactOperation({ ...image.binding, requestId: 'overflow-1', capability: 'artifact-upload', configurationSha256: overflow.configurationSha256 });
    await assert.rejects(performArtifactOperation(overflow, overflowBinding, journal, limits), error => {
      assert.equal(error.code, 'PROVIDER_FAILED'); assert.equal(error.receipt.record.writeState, 'unknown');
      assert.equal(JSON.stringify(error).includes('xxxxxxxx'), false); return true;
    });
    // 登记仍由消费者承担，只有三个不同事实分别确认后才允许登记。
    const registration = { static: staticReceipt.record.reference, image: 'sha256:' + digest(manifest), runtime: live.record.reference };
    assert.deepEqual(Object.keys(registration), ['static', 'image', 'runtime']);
  } finally {
    await journalClient.close();
    try { await fixture.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
