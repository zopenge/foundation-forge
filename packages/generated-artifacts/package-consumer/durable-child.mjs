import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { createLinuxDurableArtifactFilesystem, createWindowsNtfsDurableArtifactFilesystem } from '@openge/forge-generated-artifacts/node';

const [platform, action, root, value] = process.argv.slice(2);
assert.ok(root);
const io = platform === 'win32-ntfs' ? await createWindowsNtfsDurableArtifactFilesystem()
  : platform === 'linux' ? await createLinuxDurableArtifactFilesystem() : assert.fail('explicit provider required');
const content = Buffer.from('frozen bytes\0\u{1f680}', 'utf8');
if (action === 'write') {
  await io.ensureDirectory(root);
  await io.ensureDirectory(root, 'state/frozen');
  await io.publishBytes(root, 'state/frozen/文件.bin', content, { mode: 'exclusive' });
  await io.publishBytes(root, 'state/private', Buffer.from('test-only-credential'), { mode: 'exclusive' });
  await io.publishBytes(root, 'state/receipt', Buffer.from('before'), { mode: 'exclusive' });
  await io.publishBytes(root, 'state/receipt', Buffer.from('after'), { mode: 'replace' });
} else if (action === 'read') {
  await io.ensureDirectory(root, '');
  assert.deepEqual(await readFile(join(root, 'state/frozen/文件.bin')), content);
  assert.equal(await readFile(join(root, 'state/private'), 'utf8'), 'test-only-credential');
  assert.equal(await readFile(join(root, 'state/receipt'), 'utf8'), 'after');
  assert.deepEqual((await readdir(join(root, 'state'))).sort(), ['frozen', 'private', 'receipt']);
} else if (action === 'race') {
  try { await io.publishBytes(root, 'state/winner', Buffer.from(value), { mode: 'exclusive' }); }
  catch (error) {
    if (error?.code !== 'GENERATED_ARTIFACT_DESTINATION_OCCUPIED' || error.details?.cleanupFailed) throw error;
    process.exitCode = 17;
  }
} else assert.fail('unknown consumer action');
