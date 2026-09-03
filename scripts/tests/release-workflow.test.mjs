import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';

const releaseWorkflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);
const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const packageJsonUrl = new URL('../../package.json', import.meta.url);
const releaseRunbookUrl = new URL('../../docs/maintenance/releases.md', import.meta.url);
const dataDrivenScriptUrls = [
  new URL('../package-consumer-runner.mjs', import.meta.url),
  new URL('../publish-if-needed.mjs', import.meta.url),
  new URL('../verify-packages.mjs', import.meta.url),
  new URL('../verify-prerelease-versions.mjs', import.meta.url),
  new URL('../workspace-packages.mjs', import.meta.url),
];

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

test('exposes guarded release automation entry points', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));

  assert.equal(
    packageJson.scripts['release:configure-trusted-publishers'],
    'pnpm run check && node ./scripts/configure-trusted-publishers.mjs',
  );
  assert.equal(
    packageJson.scripts['release:dispatch-next'],
    'pnpm run check && node ./scripts/dispatch-release.mjs',
  );
  assert.equal(packageJson.scripts['release:status'], 'node ./scripts/release-status.mjs');
  assert.equal(packageJson.scripts['release:verify'], 'node ./scripts/verify-release.mjs');
  assert.equal(
    packageJson.scripts['release:request-next'],
    'pnpm run check && node ./scripts/request-next-release.mjs',
  );
});

test('discovers every public package in dependency-safe release order', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const indexes = new Map(model.packages.map(({ name }, index) => [name, index]));

  assert.ok(model.packages.length > 0);
  for (const packageValue of model.packages) {
    for (const dependency of packageValue.workspaceDependencies) {
      assert.ok(indexes.get(dependency) < indexes.get(packageValue.name));
    }
  }
});

test('keeps central package and release scripts free of package catalogues', async () => {
  const sources = await Promise.all(dataDrivenScriptUrls.map((url) => readFile(url, 'utf8')));

  for (const source of sources) {
    assert.doesNotMatch(source, /@openge\/forge-/u);
    assert.doesNotMatch(source, /releasePackageDirectories/u);
    assert.doesNotMatch(source, /https:\/\/registry\.npmjs\.org/u);
  }
});
