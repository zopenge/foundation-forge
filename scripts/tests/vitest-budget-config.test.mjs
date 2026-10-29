import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import test from 'node:test';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { discoverTestProcessSupervisor, runTestProcess } from '../test-process-runner.mjs';

const module = await import('../vitest-budget-config.mjs').catch(error => ({ error }));
const repositoryRoot = resolve(import.meta.dirname, '../..'), base = resolve(repositoryRoot, '.tmp/tests');

test('the budget wrapper preserves setup, selected files and complete coverage thresholds in one Vitest instance', { timeout: 45_000 }, async t => {
  assert.ifError(module.error);
  await mkdir(base, { recursive: true }); const root = await mkdtemp(resolve(base, 'coverage-budget-'));
  t.after(async () => { const child = relative(base, root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child)); await rm(root, { recursive: true, force: true }); });
  await writeFile(resolve(root, 'subject.js'), 'export const choose = value => value ? 1 : 0;\n');
  await writeFile(resolve(root, 'setup.mjs'), 'globalThis.originalSetup = true;\n');
  await writeFile(resolve(root, 'first.test.mjs'), 'import { it, expect } from "vitest";import {choose} from "./subject.js";it("first",()=>{expect(globalThis.originalSetup).toBe(true);expect(choose(true)).toBe(1)});\n');
  await writeFile(resolve(root, 'second.test.mjs'), 'import { it, expect } from "vitest";import {choose} from "./subject.js";it("second",()=>{expect(globalThis.originalSetup).toBe(true);expect(choose(false)).toBe(0)});\n');
  await writeFile(resolve(root, 'excluded.test.mjs'), 'throw new Error("excluded file must not execute");\n');
  await writeFile(resolve(root, 'vitest.config.mjs'), 'export default {test:{maxWorkers:7,testTimeout:12345,include:["first.test.mjs","second.test.mjs"],setupFiles:["./setup.mjs"],coverage:{provider:"v8",include:["subject.js"],reporter:["json-summary"],thresholds:{lines:100,branches:100,functions:100,statements:100}}}};\n');
  const merged = await module.createVitestBudgetConfig({ packageRoot: root, jobRoot: resolve(root, 'complete'), workers: 1, configEnv: { command: 'serve', mode: 'test' } });
  assert.equal(merged.test.maxWorkers, 1); assert.equal(merged.test.testTimeout, 12345); assert.equal(merged.test.coverage.thresholds.branches, 100);
  const supervisor = await discoverTestProcessSupervisor({ packages: (await discoverWorkspacePackageModel({ repositoryRoot })).packages });
  const invoke = (job, extra = []) => runTestProcess({ supervisor, name: job, logRoot: resolve(root, job), cwd: root, signal: t.signal,
    command: process.execPath, args: [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', '--config', resolve(repositoryRoot, 'scripts/vitest-budget-config.mjs'), ...extra],
    env: { ...process.env, VITEST_MAX_WORKERS: '1', FORGE_CHECK_PACKAGE_ROOT: root, FORGE_CHECK_JOB_ROOT: resolve(root, job), FORGE_CHECK_TEST_WORKERS: '1' } });
  await invoke('complete');
  const complete = JSON.parse(await readFile(resolve(root, 'complete/results.json'), 'utf8'));
  assert.equal(complete.numPassedTests, 2); assert.equal(complete.numFailedTests, 0);
  const totals = JSON.parse(await readFile(resolve(root, 'complete/coverage/coverage-summary.json'), 'utf8')).total;
  assert.equal(totals.branches.pct, 100);
  await assert.rejects(invoke('missing-branch', ['--testNamePattern=first']), error => error.result.exitCode !== 0 && error.result.closure.empty);
  const incomplete = JSON.parse(await readFile(resolve(root, 'missing-branch/coverage/coverage-summary.json'), 'utf8')).total;
  assert.ok(incomplete.branches.pct < 100);
  assert.equal(JSON.parse(await readFile(resolve(root, 'complete/coverage/coverage-summary.json'), 'utf8')).total.branches.pct, 100);
});
