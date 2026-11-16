import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { captureArtifactFiles, verifyArtifactFiles } from '@openge/forge-artifact-publish/node';

export async function verifyCapture() {
  const root = await mkdtemp(join(process.cwd(), 'capture-'));
  try {
    const server = join(root, 'server'), ui = join(root, 'ui');
    await mkdir(server); await mkdir(ui);
    await mkdir(join(server, 'empty', 'nested'), { recursive: true });
    await mkdir(join(ui, 'unused'));
    const raw = Uint8Array.from([0, 255, 239, 187, 191, 13, 10]);
    await writeFile(join(server, 'app.bin'), raw); await writeFile(join(ui, 'index.html'), 'ui');
    const options = {
      sources: [
        { rootDirectory: server, closure: 'exact', files: [{ sourcePath: 'app.bin', path: 'server/app.bin', role: 'control' }] },
        { rootDirectory: ui, closure: 'exact', files: [{ sourcePath: 'index.html', path: 'ui/index.html', role: 'asset',
          responseHeaders: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } }] },
      ],
      pathCaseSensitivity: 'case-sensitive', maxFiles: 10, maxEntries: 100,
      maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 2048, timeoutMilliseconds: 5000,
    };
    const captured = await captureArtifactFiles(options);
    assert.deepEqual(captured.readFile('server/app.bin'), raw);
    const manifestBytes = captured.manifestBytes;
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), captured.content.manifestSha256);
    captured.readFile('server/app.bin').fill(0); captured.manifestBytes.fill(0);
    assert.deepEqual(captured.readFile('server/app.bin'), raw);
    const verified = await verifyArtifactFiles({ ...options, manifestBytes, expectedContent: captured.content });
    assert.deepEqual(verified.content, captured.content);
    await writeFile(join(ui, 'unused', 'extra'), 'extra');
    await assert.rejects(captureArtifactFiles(options), { code: 'INVALID_SOURCE' });
    await rm(join(ui, 'unused', 'extra'));
    await writeFile(join(server, 'app.bin'), new Uint8Array(raw.length));
    await assert.rejects(verifyArtifactFiles({ ...options, manifestBytes, expectedContent: captured.content }), { code: 'INTEGRITY_MISMATCH' });
    assert.deepEqual(captured.readFile('server/app.bin'), raw);
  } finally { await rm(root, { recursive: true, force: true }); }
}
