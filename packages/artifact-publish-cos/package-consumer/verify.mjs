import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { activateArtifactRelease } from '@openge/forge-artifact-publish';
import { publishArtifactFiles } from '@openge/forge-artifact-publish/node';
import { createCosArtifactTransport } from '@openge/forge-artifact-publish-cos';
import { startCosFixture } from './cos-fixture.mjs';

const artifact = (key, text, cacheControl = 'public, max-age=31536000, immutable') => {
  const bytes = Buffer.from(text);
  return { key, bytes, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'application/octet-stream', cacheControl };
};
const options = { concurrency: 2, timeoutMilliseconds: 10_000, closeTimeoutMilliseconds: 2_000,
  maxObjectBytes: 1_024, maxTotalBytes: 4_096, maxPointerBytes: 512,
  concurrencyControl: { mode: 'external-serialization', scope: 'consumer' }, pathCaseSensitivity: 'case-sensitive' };
const credentials = { secretId: 'CONSUMER_ID', secretKey: 'CONSUMER_KEY', sessionToken: 'CONSUMER_TOKEN' };
const fixture = await startCosFixture();
let root;
const transport = () => createCosArtifactTransport({ bucket: 'fixture-1250000000', region: 'ap-test',
  credentials, endpoint: fixture.endpoint });
try {
  root = await mkdtemp(join(process.cwd(), 'cos-'));
  const object = artifact('versions/v1/实际 file%25.bin', 'immutable bytes');
  const { bytes, ...descriptor } = object;
  await writeFile(join(root, 'input.bin'), bytes);
  const plan = { sourceCommit: 'b'.repeat(40), immutablePrefix: 'versions/v1/', objects: [descriptor],
    pointer: artifact('current.json', '{"version":"v1"}', 'no-cache') };
  const receipt = await publishArtifactFiles(transport(), root,
    { ...plan, objects: [{ ...descriptor, path: 'input.bin' }] }, options);
  assert.equal(receipt.outcome, 'succeeded');
  assert.deepEqual(receipt.closure, { status: 'closed', activeRequests: 0 });
  assert.deepEqual(fixture.objects.get(object.key).bytes, bytes);
  const firstPointer = fixture.requests.findIndex(value => value.method === 'PUT' && value.key === 'current.json');
  assert.ok(fixture.requests.findIndex(value => value.method === 'GET' && value.key === object.key) < firstPointer);
  for (const value of Object.values(credentials)) assert.equal(JSON.stringify(receipt).includes(value), false);
  await fixture.assertDisconnected();

  fixture.requests.length = 0;
  const rollback = await activateArtifactRelease(transport(), plan, options);
  assert.equal(rollback.outcome, 'succeeded');
  assert.deepEqual(fixture.requests.filter(value => value.method === 'PUT').map(value => value.key), ['current.json']);

  fixture.requests.length = 0;
  const stalled = fixture.stall(object.key);
  const controller = new globalThis.AbortController();
  const cancelled = assert.rejects(activateArtifactRelease(transport(), plan, { ...options, signal: controller.signal }), error => {
    assert.equal(error.code, 'OPERATION_ABORTED');
    assert.deepEqual(error.closure, { status: 'closed', activeRequests: 0 });
    assert.equal(error.receipt.pointer.writeState, 'not-attempted');
    assert.equal(JSON.stringify(error).includes('private cancellation reason'), false);
    return true;
  });
  await Promise.race([stalled, cancelled.then(() => { throw new Error('request did not reach the fixture'); })]);
  controller.abort(new Error('private cancellation reason'));
  await cancelled;
  assert.equal(fixture.requests.some(value => value.method === 'PUT'), false);
  await fixture.assertDisconnected();
} finally {
  try { await fixture.close(); }
  finally { if (root) await rm(root, { recursive: true, force: true }); }
}

const browser = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  await assert.rejects(import('@openge/forge-artifact-publish-cos'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
assert.equal(browser.status, 0, browser.stdout + browser.stderr);
