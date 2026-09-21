import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';

const releaseWorkflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);
const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const agentsUrl = new URL('../../AGENTS.md', import.meta.url);
const packageJsonUrl = new URL('../../package.json', import.meta.url);
const publishIfNeededUrl = new URL('../publish-if-needed.mjs', import.meta.url);
const releaseRunbookUrl = new URL('../../docs/maintenance/releases.md', import.meta.url);
const dataDrivenScriptUrls = [
  new URL('../package-consumer-runner.mjs', import.meta.url),
  new URL('../publish-if-needed.mjs', import.meta.url),
  new URL('../report-first-publish.mjs', import.meta.url),
  new URL('../verify-packages.mjs', import.meta.url),
  new URL('../verify-prerelease-versions.mjs', import.meta.url),
  new URL('../workspace-packages.mjs', import.meta.url),
];

async function readWorkflow(url) {
  return parse(await readFile(url, 'utf8'));
}

function releaseSteps(workflow) {
  return workflow.jobs.release.steps;
}

test('uses a repository-scoped release App token for every Changesets write', async () => {
  const [workflow, source] = await Promise.all([
    readWorkflow(releaseWorkflowUrl),
    readFile(releaseWorkflowUrl, 'utf8'),
  ]);
  const steps = releaseSteps(workflow);
  const checkoutStep = steps.find((step) => step.uses === 'actions/checkout@v6');
  const preflight = steps.find((step) => step.id === 'validate-release-app');
  const tokenStep = steps.find((step) => step.uses === 'actions/create-github-app-token@v3');
  const changesetsStep = steps.find((step) => step.uses === 'changesets/action@v2');

  assert.ok(tokenStep, 'release workflow must create an installation token');
  assert.equal(tokenStep.id, 'release-app-token');
  assert.equal(tokenStep.if, "github.event_name == 'push'");
  assert.deepEqual(tokenStep.with, {
    'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
    'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
    repositories: '${{ github.event.repository.name }}',
    'permission-contents': 'write',
    'permission-pull-requests': 'write',
  });
  assert.equal(changesetsStep.if, tokenStep.if);
  assert.equal(changesetsStep.with['github-token'], '${{ steps.release-app-token.outputs.token }}');
  assert.equal(changesetsStep.with['push-with-git-cli'], undefined);
  assert.equal(checkoutStep.with.token, undefined);
  assert.ok(steps.indexOf(preflight) < steps.indexOf(tokenStep));
  assert.ok(steps.indexOf(tokenStep) < steps.indexOf(changesetsStep));
  assert.notEqual(changesetsStep.with['github-token'], '${{ secrets.GITHUB_TOKEN }}');
  assert.doesNotMatch(source, /secrets\.GITHUB_TOKEN/u);
});

test('fails closed when release App configuration is absent', async () => {
  const workflow = await readWorkflow(releaseWorkflowUrl);
  const steps = releaseSteps(workflow);
  const preflight = steps.find((step) => step.id === 'validate-release-app');
  const tokenStep = steps.find((step) => step.id === 'release-app-token');

  assert.ok(preflight, 'release workflow must validate App configuration');
  assert.equal(preflight.if, "github.event_name == 'push'");
  assert.equal(preflight.if, tokenStep.if);
  assert.deepEqual(preflight.env, {
    RELEASE_APP_CLIENT_ID: '${{ vars.RELEASE_APP_CLIENT_ID }}',
    RELEASE_APP_PRIVATE_KEY: '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
  });
  assert.match(preflight.run, /RELEASE_APP_CLIENT_ID/u);
  assert.match(preflight.run, /RELEASE_APP_PRIVATE_KEY/u);
  assert.match(preflight.run, /exit 1/u);
  assert.doesNotMatch(preflight.run, /continue-on-error|GITHUB_TOKEN/u);
});

test('keeps App credentials out of pull request CI and preserves the supported matrix', async () => {
  const [workflow, source] = await Promise.all([
    readWorkflow(ciWorkflowUrl),
    readFile(ciWorkflowUrl, 'utf8'),
  ]);

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.verify.strategy.matrix['node-version'], [22, 24, 26]);
  assert.doesNotMatch(source, /RELEASE_APP_|create-github-app-token|permission-contents|permission-pull-requests/u);
});

test('preserves push and manual release routes without approval or retry workarounds', async () => {
  const [workflow, source] = await Promise.all([
    readWorkflow(releaseWorkflowUrl),
    readFile(releaseWorkflowUrl, 'utf8'),
  ]);

  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.workflow_dispatch, null);
  assert.equal(workflow.jobs.release.environment, 'npm');
  assert.ok(releaseSteps(workflow).some((step) => step.if === "github.event_name == 'workflow_dispatch'" && step.run === 'pnpm release:next'));
  assert.doesNotMatch(source, /reopen|close.*pull request|skip ci|skip-ci|sleep|auto-approve/iu);
});

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

test('main push reports first-publish state and stable publishing enforces the hard gate', async () => {
  const [workflow, publishIfNeeded] = await Promise.all([
    readFile(releaseWorkflowUrl, 'utf8'),
    readFile(publishIfNeededUrl, 'utf8'),
  ]);
  const statusIndex = workflow.indexOf('node ./scripts/report-first-publish.mjs');
  const changesetsIndex = workflow.indexOf('uses: changesets/action@v2');
  assert.ok(statusIndex >= 0);
  assert.ok(changesetsIndex > statusIndex);
  assert.match(workflow.slice(Math.max(0, statusIndex - 100), statusIndex + 100), /continue-on-error: true/u);
  assert.match(publishIfNeeded, /assertTrustedPublishingReady\(states\)/u);
});

test('documents main-push automation and the first-package exception', async () => {
  const [workflow, runbook, agents] = await Promise.all([
    readFile(releaseWorkflowUrl, 'utf8'),
    readFile(releaseRunbookUrl, 'utf8'),
    readFile(agentsUrl, 'utf8'),
  ]);

  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*- main/u);
  assert.match(workflow, /uses: changesets\/action@v2/u);
  assert.match(runbook, /## 自动发布总览/u);
  assert.match(runbook, /Version Packages/u);
  assert.match(runbook, /FIRST_PUBLISH_REQUIRED/u);
  assert.match(runbook, /NPM_TOKEN/u);
  assert.match(runbook, /首次创建的新 package/u);
  assert.match(runbook, /push.*main.*自动触发/u);
  assert.match(agents, /push to `main` automatically triggers/u);
  assert.match(agents, /FIRST_PUBLISH_REQUIRED/u);
  assert.match(agents, /`release:bootstrap` is only for brand-new npm packages/u);
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
test('version package automation refreshes the pnpm lockfile for exact workspace version changes', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));
  assert.equal(
    packageJson.scripts['version:packages'],
    'changeset version && pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts',
  );
});
