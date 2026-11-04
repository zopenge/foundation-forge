import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

function startWorkflowProbe(args, options) {
  const result = Promise.withResolvers();
  let outcome;
  const child = execFile(process.execPath, args, { ...options, windowsHide: true }, (error, stdout) => {
    outcome = { error, stdout };
  });
  child.once('close', () => {
    if (!outcome) { result.reject(new Error('CI_PROBE_RESULT_MISSING')); return; }
    if (outcome.error) result.reject(outcome.error); else result.resolve({ stdout: outcome.stdout });
  });
  return { child, completion: result.promise };
}

test('a cancelled CI budget probe waits for its actual child close before rejecting', async t => {
  const controller = new globalThis.AbortController();
  const { child, completion } = startWorkflowProbe(['-e', 'setInterval(()=>{},1000)'], {
    signal: globalThis.AbortSignal.any([t.signal, controller.signal]),
  });
  let closed = false;
  const closure = new Promise(accept => child.once('close', () => { closed = true; accept(); }));
  child.once('spawn', () => { controller.abort(); });
  const observed = completion.then(() => undefined, error => error);
  try {
    assert.equal((await observed)?.code, 'ABORT_ERR');
    assert.equal(closed, true);
  } finally { controller.abort(); await closure; await observed; }
});

test('CI worker selections reach the real repository budget and serialize Windows reservations', async t => {
  const workflow = await readWorkflow(ciWorkflowUrl);
  for (const [job, expected] of [['verify', 1], ['verify-windows', 1], ['verify-gates', 1], ['merge', 1]]) {
    const selected = workflow.jobs[job].env;
    // 在独立子进程中清除外层测试的预算注入，重现 Actions 根命令的实际环境。
    const { completion } = startWorkflowProbe(['--input-type=module', '-e', `
      import {setImmediate} from 'node:timers/promises';
      import {createTestWorkerBudget} from ${JSON.stringify(new URL('../test-worker-budget.mjs', import.meta.url).href)};
      const budget=createTestWorkerBudget(), gate=Promise.withResolvers(); let running=0, peak=0;
      const tasks=[0,1].map(index=>budget.run({name:String(index),workers:1},async()=>{
        running++;peak=Math.max(peak,running);await gate.promise;running--;
      }));
      await setImmediate(); const observed=peak; gate.resolve(); await Promise.all(tasks);
      console.log(JSON.stringify({limit:budget.limit,peak:observed,active:budget.summary().activeWorkers}));
    `], { signal: t.signal, windowsHide: true, env: { ...process.env,
      VITEST_MAX_WORKERS: undefined, FORGE_CHECK_TEST_WORKERS: undefined, ...selected } });
    assert.deepEqual(JSON.parse((await completion).stdout), { limit: expected, peak: expected, active: 0 }, job);
  }
});

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

test('allows CI only through an explicit manual dispatch', async () => {
  const workflow = await readWorkflow(ciWorkflowUrl);

  assert.deepEqual(workflow.on, { workflow_dispatch: null });
});

test('keeps Node 24 and requires common gates plus complete per-platform coverage without App credentials', async () => {
  const [workflow, source] = await Promise.all([
    readWorkflow(ciWorkflowUrl),
    readFile(ciWorkflowUrl, 'utf8'),
  ]);

  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.verify.strategy.matrix['node-version'], [24]);
  assert.deepEqual(workflow.jobs.verify.strategy.matrix.os, ['ubuntu-24.04']);
  assert.deepEqual(workflow.jobs.verify.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(workflow.jobs.verify.strategy.matrix.include, undefined);
  const steps = workflow.jobs.verify.steps;
  assert.ok(steps.some((step) => step.run === 'pnpm install --frozen-lockfile'));
  assert.ok(steps.some((step) => step.run === 'pnpm build'));
  assert.ok(steps.some((step) => step.run === 'pnpm check:ci --coverage-shard ${{ matrix.shard }}/4'));
  const windows = workflow.jobs['verify-windows'];
  assert.equal(windows['runs-on'], 'windows-2025');
  assert.deepEqual(windows.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(windows.strategy['fail-fast'], false);
  assert.equal(windows.steps.find(step => step.uses === 'actions/setup-node@v6').with['node-version'], 24);
  assert.ok(windows.steps.some(step => step.run === 'pnpm build'));
  assert.ok(windows.steps.some(step => step.run === 'pnpm check:ci --coverage-shard ${{ matrix.shard }}/8'));
  const upload = windows.steps.find(step => step.uses === 'actions/upload-artifact@v7');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['include-hidden-files'], true);
  assert.equal(upload.with.path, '.tmp/ci-shards/');
  assert.equal(upload.with['retention-days'], 1);
  const gates = workflow.jobs['verify-gates'];
  assert.deepEqual(gates.strategy.matrix.os, ['ubuntu-24.04', 'windows-2025']);
  assert.equal(gates['runs-on'], '${{ matrix.os }}');
  assert.ok(gates.steps.some(step => step.run === 'pnpm check:ci --gates'));
  const merge = workflow.jobs.merge;
  assert.deepEqual(merge.needs, ['verify', 'verify-windows']);
  assert.deepEqual(merge.strategy.matrix.os, ['ubuntu-24.04', 'windows-2025']);
  assert.equal(merge['runs-on'], '${{ matrix.os }}');
  assert.equal(merge.if, undefined);
  assert.ok(merge.steps.some(step => step.run === 'pnpm build'));
  assert.ok(merge.steps.some(step => step.run === 'pnpm check:ci --merge .tmp/ci-shards'));
  const download = merge.steps.find(step => step.uses === 'actions/download-artifact@v8');
  assert.equal(download.with.pattern, '${{ matrix.os }}-coverage-*-${{ github.run_attempt }}');
  assert.equal(download.with['merge-multiple'], true);
  assert.equal(download.with.path, '.tmp/ci-shards');
  const complete = workflow.jobs.complete;
  assert.deepEqual(complete.needs, ['verify-gates', 'merge']);
  assert.equal(complete.if, '${{ always() }}');
  assert.equal(complete['runs-on'], 'ubuntu-24.04');
  assert.equal(complete.steps[0].run.trim(), "test '${{ needs.verify-gates.result }}' = success\ntest '${{ needs.merge.result }}' = success");
  for (const job of [workflow.jobs.verify, windows, gates, merge]) {
    assert.equal(job.if, undefined);
    assert.equal(job.steps.find(step => step.uses === 'actions/setup-node@v6').with['node-version'] === 24
      || job.steps.find(step => step.uses === 'actions/setup-node@v6').with['node-version'] === '${{ matrix.node-version }}', true);
    assert.ok(job.steps.some(step => step.run === 'pnpm install --frozen-lockfile'));
  }
  for (const job of [workflow.jobs.verify, windows, gates, merge])
    assert.equal(job['continue-on-error'], undefined);
  assert.doesNotMatch(source, /continue-on-error|--no-coverage|--passWithNoTests/u);
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
    'pnpm run check:full && node ./scripts/bootstrap-publish.mjs',
  );
  assert.match(runbook, /pnpm release:bootstrap/u);
  assert.match(runbook, /spawn\('pnpm\.cmd'.*shell: false/u);
  assert.match(runbook, /Automatic provenance generation not\s+supported/u);
});

test('exposes guarded release automation entry points', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));

  assert.equal(
    packageJson.scripts['release:configure-trusted-publishers'],
    'pnpm run check:full && node ./scripts/configure-trusted-publishers.mjs',
  );
  assert.equal(
    packageJson.scripts['release:dispatch-next'],
    'pnpm run check:full && node ./scripts/dispatch-release.mjs',
  );
  assert.equal(packageJson.scripts['release:status'], 'node ./scripts/release-status.mjs');
  assert.equal(packageJson.scripts['release:verify'], 'node ./scripts/verify-release.mjs');
  assert.equal(
    packageJson.scripts['release:request-next'],
    'pnpm run check:full && node ./scripts/request-next-release.mjs',
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
