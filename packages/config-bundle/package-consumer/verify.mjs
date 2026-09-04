import { execFileSync } from 'node:child_process';
import { execPath, env } from 'node:process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { TextEncoder } from 'node:util';
import { createConfigBundle, decodeConfigBundle } from '@openge/forge-config-bundle';
import { inspectConfigBundleImport, applyConfigBundleImport } from '@openge/forge-config-bundle/node';

const content = new TextEncoder().encode('new');
const bytes = await createConfigBundle([{ path: 'config/a', content }], { createdAt: '2026-09-04T00:00:00Z' });
const bundle = await decodeConfigBundle(bytes);
assert.deepEqual(bundle.entries, [{ path: 'config/a', content }]);
assert.ok(env.PACKAGE_CONSUMER_ROOT);
const root = await fs.mkdtemp(path.join(env.PACKAGE_CONSUMER_ROOT, 'config-bundle-'));
const baseOptions = { pathCaseSensitivity: 'case-sensitive' };
try {
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config/a'), 'old');
  const options = { ...baseOptions, conflictPolicy: 'reject' };
  assert.deepEqual((await inspectConfigBundleImport(root, bundle, options)).conflicts, ['config/a']);
  assert.equal((await applyConfigBundleImport(root, bundle, options)).diagnostics[0].phase, 'preflight');
  assert.equal(await fs.readFile(path.join(root, 'config/a'), 'utf8'), 'old');
  const result = await applyConfigBundleImport(root, bundle, { ...baseOptions, conflictPolicy: 'backup-and-overwrite', backupDirectory: path.join(root, 'backups/run') });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(await fs.readFile(path.join(root, 'config/a'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(root, 'backups/run/config/a'), 'utf8'), 'old');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

execFileSync(execPath, ['--conditions=browser', '--input-type=module', '-e',
  "import assert from 'node:assert/strict'; import { createConfigBundle, decodeConfigBundle } from '@openge/forge-config-bundle'; const zip = await createConfigBundle([], { createdAt: '2026-09-04T00:00:00Z' }); assert.equal((await decodeConfigBundle(zip)).entries.length, 0); await assert.rejects(import('@openge/forge-config-bundle/node'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });"
], { cwd: import.meta.dirname, stdio: 'pipe' });
