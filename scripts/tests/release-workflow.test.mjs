import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { releasePackageDirectories } from '../release-package-directories.mjs';

const releaseWorkflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);
const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const packageJsonUrl = new URL('../../package.json', import.meta.url);
const releaseRunbookUrl = new URL('../../docs/maintenance/releases.md', import.meta.url);

test('pushes package tags for manual and action-driven releases', async () => {
  const workflow = await readFile(releaseWorkflowUrl, 'utf8');

  assert.match(workflow, /run: git push origin --tags/u);
  assert.doesNotMatch(workflow, /git push --follow-tags/u);
  assert.match(workflow, /push-git-tags: true/u);
  assert.match(workflow, /create-github-releases: true/u);
  assert.match(workflow, /pnpm\/action-setup@v6/u);
});

test('runs pnpm setup on the supported GitHub Actions runtime', async () => {
  const workflows = await Promise.all([
    readFile(ciWorkflowUrl, 'utf8'),
    readFile(releaseWorkflowUrl, 'utf8'),
  ]);

  for (const workflow of workflows) {
    assert.match(workflow, /pnpm\/action-setup@v6/u);
    assert.doesNotMatch(workflow, /pnpm\/action-setup@v4/u);
  }
});

test('documents and exposes the guarded new-package bootstrap command', async () => {
  const [packageJson, runbook] = await Promise.all([
    readFile(packageJsonUrl, 'utf8').then(JSON.parse),
    readFile(releaseRunbookUrl, 'utf8'),
  ]);

  assert.equal(
    packageJson.scripts['release:bootstrap'],
    'pnpm run check && node ./scripts/bootstrap-publish.mjs',
  );
  assert.match(runbook, /pnpm release:bootstrap/u);
  assert.match(runbook, /spawn\('pnpm\.cmd'.*shell: false/u);
  assert.match(runbook, /Automatic provenance generation not\s+supported/u);
});

test('releases workspace checks after their graph and Provider dependencies', () => {
  const graphIndex = releasePackageDirectories.indexOf('packages/workspace-graph');
  const checksIndex = releasePackageDirectories.indexOf('packages/workspace-checks');
  const pnpmIndex = releasePackageDirectories.indexOf('packages/workspace-pnpm');
  const checksPnpmIndex = releasePackageDirectories.indexOf('packages/workspace-checks-pnpm');

  assert.ok(graphIndex >= 0);
  assert.ok(checksIndex > graphIndex);
  assert.ok(pnpmIndex > graphIndex);
  assert.ok(checksPnpmIndex > checksIndex);
  assert.ok(checksPnpmIndex > pnpmIndex);
});
