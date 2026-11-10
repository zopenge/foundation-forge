import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createClient, digest } from './multi-http.mjs';

const [endpoint, kind, file, expectedSha, lose] = process.argv.slice(2);
const client = createClient(endpoint);
const headers = { authorization: 'Bearer ' + process.env.PUBLISH_SECRET,
  'x-request-id': process.env.FORGE_ARTIFACT_REQUEST_ID, 'x-fingerprint': process.env.FORGE_ARTIFACT_FINGERPRINT,
  'x-source-commit': process.env.FORGE_ARTIFACT_SOURCE_COMMIT };
const send = async (route, bytes, method = 'POST', extra = {}) => {
  const response = await client.call(route, { method, bytes, headers: { ...headers, ...extra } });
  assert.ok([201, 202].includes(response.status));
};
try {
  const bytes = await readFile(file);
  assert.equal(digest(bytes), expectedSha);
  if (kind === 'static') await send('/deployments', bytes, 'POST', lose === 'lose' ? { 'x-lose-response': 'yes' } : {});
  else if (kind === 'image') {
    const archive = JSON.parse(bytes), manifest = Buffer.from(archive.manifest, 'base64');
    for (const entry of archive.blobs) {
      const blob = Buffer.from(entry.bytes, 'base64');
      assert.equal(digest(blob), entry.sha256);
      await send('/v2/fixture/blobs/uploads/', Buffer.alloc(0));
      await send('/v2/fixture/blobs/uploads/u1?digest=sha256:' + entry.sha256, blob, 'PUT');
    }
    await send('/v2/fixture/manifests/release-1', manifest, 'PUT');
  } else if (kind === 'runtime') await send('/runtime/deployments', bytes);
  else throw Error('unknown fixture command');
} finally { await client.close(); }
