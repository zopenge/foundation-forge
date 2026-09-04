import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { defineGeneratedArtifactPlan, compareGeneratedArtifactSnapshot } from '@openge/forge-generated-artifacts';
import { inspectGeneratedArtifacts, publishGeneratedArtifacts } from '@openge/forge-generated-artifacts/node';

const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'nested/output', content: 'hi' }], retiredPaths: ['old'] });
assert.equal(compareGeneratedArtifactSnapshot(plan, [{ path: 'nested/output', content: new Uint8Array([104, 105]) }]).ok, true);
const root = await mkdtemp(join(process.cwd(), 'generated-artifacts-consumer-'));
try {
  const options = { pathCaseSensitivity: 'case-sensitive' };
  assert.deepEqual((await inspectGeneratedArtifacts(root, plan, options)).missing, ['nested/output']);
  assert.deepEqual((await publishGeneratedArtifacts(root, plan, options)).written, ['nested/output']);
  assert.equal(await readFile(join(root, 'nested/output'), 'utf8'), 'hi');
  assert.deepEqual((await publishGeneratedArtifacts(root, plan, options)).unchanged, ['nested/output']);
} finally { await rm(root, { recursive: true, force: true }); }

const browser = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  const core = await import('@openge/forge-generated-artifacts');
  assert.equal(core.defineGeneratedArtifactPlan({ artifacts: [] }).artifacts.length, 0);
  await assert.rejects(import('@openge/forge-generated-artifacts/node'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
assert.equal(browser.status, 0, browser.stdout + browser.stderr);
