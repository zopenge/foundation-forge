import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { createTestRunContext } from '../test-run-context.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');

test('a pool drain failure rejects the CLI even when its descendant subsequently exits normally', { timeout: 30_000 }, async t => {
  const base = resolve(repositoryRoot, '.tmp/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'finite-pipe-'));
  t.after(async () => {
    const child = relative(base, root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  const context = await createTestRunContext({ packages: (await discoverWorkspacePackageModel({ repositoryRoot })).packages, workers: 1 });
  const release = resolve(root, 'release'), ready = resolve(root, 'ready'), logRoot = resolve(context.root, 'finite-pipe');
  const childCode = 'const f=require("node:fs");f.writeFileSync(process.argv[1],"ready");const t=setInterval(()=>{if(f.existsSync(process.argv[2])){clearInterval(t)}},10)';
  await writeFile(resolve(root, 'finite.test.mjs'), `import {it} from 'vitest';import {spawn} from 'node:child_process';import {readFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
    it('finite pipe holder',async()=>{const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)},${JSON.stringify(ready)},${JSON.stringify(release)}],{detached:true,windowsHide:true,stdio:'inherit'});child.unref();const end=Date.now()+5000;while(Date.now()<end){try{await readFile(${JSON.stringify(ready)});return;}catch(error){if(error.code!=='ENOENT')throw error;}await delay(10);}throw new Error('readiness deadline');});`);
  await writeFile(resolve(root, 'vitest.config.mjs'), 'export default {test:{include:["finite.test.mjs"],teardownTimeout:100}};');
  try {
    await context.budget.run({ name: 'expected-finite-pipe-failure', workers: 1 }, async lease => {
      const terminal = context.execute({ name: 'finite-pipe', command: process.execPath, cwd: root, logRoot, signal: t.signal,
        args: [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(repositoryRoot, 'scripts/vitest-budget-config.mjs')],
        env: { ...process.env, FORGE_CHECK_PACKAGE_ROOT: root } }, lease).then(result => ({ result }), error => ({ error }));
      try {
        const deadline = Date.now() + 10_000; let reported = false;
        while (Date.now() < deadline) {
          const output = await readFile(resolve(logRoot, 'stderr.log'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
          if (output.includes('output did not close')) { reported = true; break; }
          await delay(10);
        }
        assert.equal(reported, true);
      } finally { await writeFile(release, 'release'); }
      const outcome = await terminal;
      assert.ok(outcome.error, 'pool teardown failure must reject even with an empty normally closed Job');
      assert.ok(outcome.error.result.exitCode !== 0);
      assert.equal(outcome.error.result.closure.status, 'closed'); assert.equal(outcome.error.result.closure.empty, true);
      process.stdout.write(`FINITE_PIPE_PROOF ${JSON.stringify(outcome.error.result)}\n`);
    });
  } finally { await writeFile(release, 'release'); await context.finalize(); }
});
