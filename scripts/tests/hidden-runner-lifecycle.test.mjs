import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { discoverTestProcessSupervisor } from '../test-process-runner.mjs';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { createTestRunContext } from '../test-run-context.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const probe = new URL('./fixtures/test-process/console-visibility.mjs', import.meta.url).href;

test('hidden runners preserve file isolation and observe real exits for skipped and failed collection workers', { timeout: 45_000 }, async t => {
  const base = resolve(repositoryRoot, '.tmp/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'hidden-runners-'));
  t.after(async () => {
    const child = relative(base, root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const adapter = model.packages.find(value => value.manifest.dependencies?.koffi); assert.ok(adapter);
  const context = await createTestRunContext({ packages: model.packages, workers: 1 });
  const env = { ...process.env, FORGE_KOFFI_PACKAGE: resolve(adapter.packageRoot, 'package.json') };
  const nodeFile = resolve(root, 'driver.test.mjs');
  await writeFile(nodeFile, `import assert from 'node:assert/strict';import test from 'node:test';import {writeFileSync} from 'node:fs';import {inspectOwnConsole} from ${JSON.stringify(probe)};
    test('isolated driver',()=>{assert.equal(globalThis.driverLeak,undefined);globalThis.driverLeak=true;writeFileSync(process.env.FORGE_DRIVER_RESULT,JSON.stringify(inspectOwnConsole(process.env.FORGE_KOFFI_PACKAGE)));console.log('node-output');});`);
  const observations = [], ownedJobs = new Set();
  try {
    for (let index = 0; index < 2; index++) {
      const marker = resolve(root, `node-${index}.json`);
      const result = await context.run({ name: `hidden-node-${index}`, command: process.execPath, cwd: root, signal: t.signal,
        args: ['--import', new URL('../node-test-worker-observer.mjs', import.meta.url).href, '--test', '--experimental-test-isolation=none', nodeFile],
        env: { ...env, FORGE_NODE_TEST_FILE: nodeFile, FORGE_DRIVER_RESULT: marker } });
      ownedJobs.add(result.jobId);
      assert.match(result.stdout, /node-output/u);
      const observation = JSON.parse(await readFile(marker, 'utf8'));
      if (process.platform === 'win32') assert.equal(observation.visible, false);
      observations.push(observation);
    }
    assert.notEqual(observations[0].pid, observations[1].pid);
    const subject = `import {it,expect} from 'vitest';import {writeFileSync} from 'node:fs';import {inspectOwnConsole} from ${JSON.stringify(probe)};`;
    await writeFile(resolve(root, 'first.test.mjs'), `${subject}it('first',()=>{expect(globalThis.vitestLeak).toBeUndefined();globalThis.vitestLeak=true;writeFileSync(process.env.FORGE_VITEST_RESULT+'-first',JSON.stringify(inspectOwnConsole(process.env.FORGE_KOFFI_PACKAGE)));});it.skip('skipped',()=>{});it.todo('todo');`);
    await writeFile(resolve(root, 'second.test.mjs'), `${subject}it('second',()=>{expect(globalThis.vitestLeak).toBeUndefined();writeFileSync(process.env.FORGE_VITEST_RESULT+'-second',JSON.stringify(inspectOwnConsole(process.env.FORGE_KOFFI_PACKAGE)));});`);
    await writeFile(resolve(root, 'broken.test.mjs'), 'throw new Error("EXPECTED_COLLECTION_FAILURE");');
    await writeFile(resolve(root, 'vitest.config.mjs'), 'export default {test:{include:["first.test.mjs","second.test.mjs"],isolate:true}};');
    const invoke = (name, extra = []) => ({ name, command: process.execPath, cwd: root, signal: t.signal,
      args: [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(repositoryRoot, 'scripts/vitest-budget-config.mjs'), ...extra],
      env: { ...env, FORGE_CHECK_PACKAGE_ROOT: root, FORGE_VITEST_RESULT: resolve(root, name) } });
    const complete = await context.run(invoke('hidden-vitest-complete'));
    ownedJobs.add(complete.jobId);
    const result = JSON.parse(await readFile(resolve(complete.logRoot, 'results.json'), 'utf8'));
    assert.equal(result.numPassedTests, 2); assert.equal(result.numPendingTests, 1); assert.equal(result.numTodoTests, 1);
    for (const file of ['first', 'second']) {
      const observation = JSON.parse(await readFile(resolve(root, `hidden-vitest-complete-${file}`), 'utf8'));
      if (process.platform === 'win32') assert.equal(observation.visible, false);
      observations.push(observation);
    }
    assert.notEqual(observations[2].pid, observations[3].pid);
    const skipped = await context.run(invoke('hidden-vitest-filtered', ['--testNamePattern=first']));
    ownedJobs.add(skipped.jobId);
    const filtered = JSON.parse(await readFile(resolve(skipped.logRoot, 'results.json'), 'utf8'));
    assert.equal(filtered.numPassedTests, 1); assert.equal(filtered.numTotalTests, 4);
    assert.equal(filtered.numPendingTests + filtered.numTodoTests, 3); assert.equal(filtered.numFailedTests, 0);
    await writeFile(resolve(root, 'vitest.config.mjs'), 'export default {test:{include:["broken.test.mjs"],isolate:true}};');
    await context.budget.run({ name: 'expected-collection-failure', workers: 1 }, async lease => {
      await assert.rejects(context.execute(invoke('hidden-vitest-collection-failure'), lease), error => {
        assert.ok(error.result.exitCode !== 0 && error.result.closure.empty === true);
        ownedJobs.add(error.result.jobId);
        assert.match(error.message, /EXPECTED_COLLECTION_FAILURE/u); return true;
      });
    });
    const heldPipeMarker = resolve(root, 'held-pipe-child.json');
    const heldPipeChild = 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},100)';
    await writeFile(resolve(root, 'held-pipe.test.mjs'), `import {it} from 'vitest';import {spawn} from 'node:child_process';import {readFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
      it('held output pipe',async()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(heldPipeChild)},${JSON.stringify(heldPipeMarker)}],{detached:true,windowsHide:true,stdio:'inherit'});child.unref();const end=Date.now()+5000;while(Date.now()<end){try{await readFile(${JSON.stringify(heldPipeMarker)});return;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}throw new Error('readiness deadline');});`);
    await writeFile(resolve(root, 'vitest.config.mjs'), 'export default {test:{include:["held-pipe.test.mjs"],isolate:true,teardownTimeout:300}};');
    await context.budget.run({ name: 'expected-held-pipe-failure', workers: 1 }, async lease => {
      await assert.rejects(context.execute(invoke('hidden-vitest-held-pipe'), lease), error => {
        assert.equal(error.result.closure.empty, true);
        ownedJobs.add(error.result.jobId);
        assert.ok(error.result.exitCode !== 0 || error.result.closure.status !== 'closed'); return true;
      });
    });
    const descendant = JSON.parse(await readFile(heldPipeMarker, 'utf8'));
    const supervisor = await discoverTestProcessSupervisor({ packages: model.packages });
    assert.equal((await supervisor.reader.readIdentity({ pid: descendant.pid })).status, 'ABSENT');
    const events = (await readFile(context.workerEvents, 'utf8')).trim().split(/\r?\n/u)
      .map(line => JSON.parse(line)).filter(event => ownedJobs.has(event.jobId));
    for (const pid of observations.map(value => value.pid)) {
      assert.ok(events.some(value => value.pid === pid && value.type === 'start'));
      assert.ok(events.some(value => value.pid === pid && value.type === 'finish'));
    }
    const vitestEvents = events.filter(value => value.kind === 'vitest');
    const starts = vitestEvents.filter(value => value.type === 'start');
    assert.equal(starts.length, 6);
    const active = new Set(); let peak = 0;
    for (const event of vitestEvents) {
      if (event.type === 'start') active.add(`${event.jobId}:${event.pid}`);
      else if (event.type === 'finish') assert.equal(active.delete(`${event.jobId}:${event.pid}`), true);
      peak = Math.max(peak, active.size);
    }
    assert.equal(peak, 1); assert.equal(active.size, 0);
    const summary = await context.finalize();
    assert.equal(summary.activeWorkers, 0); assert.equal(summary.remainingWorkers.length, 0);
    await writeFile(resolve(context.root, 'hidden-runner-proof.json'), JSON.stringify({ observations, summary, vitestPeak: peak, vitestStarts: starts.length, heldPipeDescendant: { pid: descendant.pid, status: 'ABSENT' } }, null, 2));
    process.stdout.write(`HIDDEN_RUNNER_PROOF ${context.root}\n${JSON.stringify({ observations, summary, vitestPeak: peak, vitestStarts: starts.length, heldPipeDescendant: { pid: descendant.pid, status: 'ABSENT' } })}\n`);
  } finally { await context.finalize(); }
});
