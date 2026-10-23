import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { activateArtifactRelease, publishArtifactRelease } from '@openge/forge-artifact-publish';
import { publishArtifactFiles } from '@openge/forge-artifact-publish/node';

const artifact = (key, text) => {
  const bytes = Buffer.from(text);
  return { key, bytes, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' };
};
const objects = new Map();
const events = [];
const transport = () => ({
  target: { provider: 'consumer-fixture', namespace: 'artifacts', endpoint: 'https://storage.invalid' },
  async prepare() {},
  async createObject(object) {
    events.push(`create:${object.key}`);
    if (objects.has(object.key)) return 'exists';
    objects.set(object.key, { ...object, bytes: Uint8Array.from(object.bytes) });
    return 'created';
  },
  async readObject({ key }) {
    events.push(`read:${key}`);
    const value = objects.get(key);
    assert.ok(value);
    return value;
  },
  async replaceObject(object) {
    events.push(`pointer:${object.key}`);
    objects.set(object.key, { ...object, bytes: Uint8Array.from(object.bytes) });
  },
  async close() { return { status: 'closed', activeRequests: 0 }; },
});
const options = { concurrency: 2, timeoutMilliseconds: 5_000, closeTimeoutMilliseconds: 1_000,
  maxObjectBytes: 1_024, maxTotalBytes: 4_096, maxPointerBytes: 512,
  concurrencyControl: { mode: 'external-serialization', scope: 'consumer' } };
const object = artifact('versions/v1/object', 'actual artifact bytes');
const plan = { sourceCommit: 'a'.repeat(40), immutablePrefix: 'versions/v1/', objects: [object],
  pointer: { ...artifact('current.json', '{"version":"v1"}'), cacheControl: 'no-cache' } };
const receipt = await publishArtifactRelease(transport(), plan, options);
assert.equal(receipt.outcome, 'succeeded');
assert.deepEqual(receipt.closure, { status: 'closed', activeRequests: 0 });
assert.ok(events.indexOf(`read:${object.key}`) < events.indexOf('pointer:current.json'));
assert.equal(JSON.stringify(receipt).includes('actual artifact bytes'), false);

events.length = 0;
const activation = await activateArtifactRelease(transport(), plan, options);
assert.equal(activation.objects[0].writeState, 'not-attempted');
assert.equal(events.some(value => value.startsWith('create:')), false);
objects.set(object.key, { ...object, bytes: Buffer.from('different content') });
events.length = 0;
await assert.rejects(activateArtifactRelease(transport(), plan, options), error => {
  assert.equal(error.code, 'INTEGRITY_MISMATCH');
  assert.equal(error.receipt.pointer.writeState, 'not-attempted');
  return true;
});
assert.equal(events.some(value => value.startsWith('pointer:')), false);

const root = await mkdtemp(join(process.cwd(), 'ap-'));
try {
  objects.clear();
  const { bytes, ...descriptor } = object;
  await writeFile(join(root, 'input.bin'), bytes);
  const fileReceipt = await publishArtifactFiles(transport(), root,
    { ...plan, objects: [{ ...descriptor, path: 'input.bin' }] },
    { ...options, pathCaseSensitivity: 'case-sensitive' });
  assert.equal(fileReceipt.outcome, 'succeeded');
  assert.deepEqual(Buffer.from(objects.get(object.key).bytes), object.bytes);
} finally { await rm(root, { recursive: true, force: true }); }

const browser = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  const core = await import('@openge/forge-artifact-publish');
  assert.equal(typeof core.publishArtifactRelease, 'function');
  await assert.rejects(import('@openge/forge-artifact-publish/node'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
assert.equal(browser.status, 0, browser.stdout + browser.stderr);
