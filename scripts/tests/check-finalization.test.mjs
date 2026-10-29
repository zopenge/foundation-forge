import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';

const scopedRunner = async t => {
  const base = resolve(import.meta.dirname, '../../.tmp/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'finalization-'));
  t.after(async () => {
    const child = relative(base, root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  const scriptRoot = resolve(root, 'scripts'); await mkdir(scriptRoot);
  const source = await readFile(new URL('../check-runner.mjs', import.meta.url), 'utf8');
  await writeFile(resolve(scriptRoot, 'check-runner.mjs'), source);
  for (const [, name] of source.matchAll(/from '(\.\/[^']+)'/gu)) {
    await writeFile(resolve(scriptRoot, name), `export * from ${JSON.stringify(new URL(`../${name}`, import.meta.url).href)};\n`);
  }
  const { runPackages } = await import(pathToFileURL(resolve(scriptRoot, 'check-runner.mjs')).href);
  return { root, runPackages };
};

test('a failed final worker audit cannot leave a targeted success receipt', async t => {
  const { root, runPackages } = await scopedRunner(t);
  const packageRoot = resolve(root, 'package'), packRoot = resolve(root, '.tmp/check-cache/packs');
  await mkdir(packageRoot); await mkdir(packRoot, { recursive: true });
  await writeFile(resolve(packRoot, 'tarballs.json'), '{"example":"example.tgz"}');
  const tarball = resolve(root, 'next.tgz'); await writeFile(tarball, 'verified tarball');
  const receipt = resolve(root, 'receipt.json'), calls = [];
  let rejectAudit = true;
  const run = () => runPackages({
    fingerprint: {}, model: { packages: [{ name: 'example', packageRoot }] }, packageNames: ['example'],
    state: { distDigests: {}, tarballDigests: {} }, tarballDigests: { example: { filename: 'example.tgz' } },
    run: async args => {
      if (args.at(-1) === 'build') {
        await mkdir(resolve(packageRoot, 'dist'), { recursive: true });
        await writeFile(resolve(packageRoot, 'dist/index.js'), 'export const value = 1;');
      }
    },
    createContext: async () => ({ budget: { stop() {} }, finalize: async () => {
      calls.push('finalize'); if (rejectAudit) throw new Error('worker audit failed');
    } }),
    scriptTests: async () => {}, coverage: async () => {},
    targetedVerify: async () => ({ targetTarballs: new Map([['example', tarball]]) }),
    docsValid: async () => {}, distValid: async () => true, tarballsValid: async () => ({}), assertInputs: async () => {},
    persist: async () => { calls.push('persist'); await writeFile(receipt, 'success'); },
  });
  await assert.rejects(run(), /worker audit failed/u);
  assert.equal(calls.includes('persist'), false);
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
  rejectAudit = false; calls.length = 0;
  await run();
  assert.deepEqual(calls, ['finalize', 'persist']);
  assert.equal(await readFile(receipt, 'utf8'), 'success');
});

const stageFixture = async t => {
  const { root, runPackages } = await scopedRunner(t), packages = [];
  const packs = resolve(root, '.tmp/check-cache/packs'); await mkdir(packs, { recursive: true });
  const targetTarballs = new Map(), tarballDigests = {};
  for (const name of ['one', 'two']) {
    const packageRoot = resolve(root, name); await mkdir(resolve(packageRoot, 'dist'), { recursive: true });
    await writeFile(resolve(packageRoot, 'dist/index.js'), name);
    await writeFile(resolve(packs, `${name}.tgz`), `old ${name}`);
    const tarball = resolve(root, `${name}-new.tgz`); await writeFile(tarball, `new ${name}`);
    packages.push({ name, packageRoot }); targetTarballs.set(name, tarball); tarballDigests[name] = { filename: `${name}.tgz` };
  }
  await writeFile(resolve(packs, 'tarballs.json'), JSON.stringify(Object.fromEntries(packages.map(value => [value.name, `${value.name}.tgz`]))));
  return { root, runPackages, packages, targetTarballs, tarballDigests };
};
const turn = () => new Promise(accept => setImmediate(accept));
const pending = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };

test('a failed targeted work-directory cleanup cannot leave a success receipt', async t => {
  const fixture = await stageFixture(t), receipt = resolve(fixture.root, 'receipt.json');
  const failure = Object.assign(new Error('owned work-directory cleanup failed'), { code: 'EBUSY' });
  let finalized = 0, cleanupCalls = 0;
  await assert.rejects(fixture.runPackages({
    fingerprint: {}, model: { packages: fixture.packages }, packageNames: ['one', 'two'],
    state: { distDigests: {}, tarballDigests: {} }, tarballDigests: fixture.tarballDigests,
    run: async () => {}, prepare: async () => {},
    createContext: async () => ({ budget: { stop() {} }, finalize: async () => { finalized++; } }),
    targetedVerify: async () => ({ targetTarballs: fixture.targetTarballs }),
    scriptTests: async () => {}, coverage: async () => {}, docsValid: async () => {},
    distValid: async () => true, tarballsValid: async () => ({}), assertInputs: async () => {},
    removeWorkRoot: async directory => {
      assert.equal(finalized, 1);
      const inside = relative(resolve(fixture.root, '.tmp/check-cache'), directory);
      assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
      cleanupCalls++; throw failure;
    },
    persist: async () => { await writeFile(receipt, 'success'); },
  }), error => error === failure);
  assert.equal(cleanupCalls, 1);
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
});

test('targeted heavy stages wait for lint, one build stage and consumer closure', async t => {
  const fixture = await stageFixture(t), calls = [], builds = [];
  const order = ['lint', 'build-stage', 'packing', 'consumers', 'type:one', 'type:two', 'scripts', 'coverage'];
  const gates = Object.fromEntries(order.map(name => [name, pending()]));
  const lintStarted = pending();
  let created = 0, finalized = 0, persisted = false;
  const context = { budget: createTestWorkerBudget({ limit: 2 }), finalize: async () => {
    finalized++; assert.equal(context.budget.summary().activeWorkers, 0);
  } };
  const phase = async name => { calls.push(name); if (name === 'lint') lintStarted.resolve(); await gates[name].promise; };
  const work = fixture.runPackages({ fingerprint: {}, model: { packages: fixture.packages }, packageNames: ['one', 'two'],
    state: { distDigests: {}, tarballDigests: {} }, tarballDigests: fixture.tarballDigests,
    run: async args => {
      if (args.at(-1) === 'lint') await phase('lint');
      if (args.at(-1) === 'typecheck') await phase(`type:${args[1]}`);
      if (args.at(-1) === 'build') builds.push(args[1]);
    },
    prepare: async ({ build }) => { await phase('build-stage'); await build(); },
    createContext: async () => { created++; return context; },
    targetedVerify: async ({ testRun }) => {
      assert.equal(testRun, context); await phase('packing'); calls.push('consumers');
      await Promise.all([1, 2].map(index => context.budget.run({ name: `consumer-${index}`, workers: 1 }, () => gates.consumers.promise)));
      return { targetTarballs: fixture.targetTarballs };
    },
    scriptTests: value => { assert.equal(value, context); return value.budget.run({ name: 'scripts', workers: 2 }, () => phase('scripts')); },
    coverage: ({ context: value, packages }) => {
      assert.equal(value, context); assert.equal(packages.length, 2);
      return value.budget.run({ name: 'coverage', workers: 2 }, () => phase('coverage'));
    },
    docsValid: async () => {}, distValid: async () => true, tarballsValid: async () => ({}), assertInputs: async () => {},
    persist: async () => { assert.equal(finalized, 1); persisted = true; },
  });
  try {
    await Promise.race([lintStarted.promise, work]); assert.deepEqual(calls, ['lint']); assert.deepEqual(builds, []); assert.equal(created, 0);
    for (const [index, name] of order.entries()) {
      assert.deepEqual(calls, order.slice(0, index + 1));
      if (name === 'consumers') assert.equal(context.budget.summary().activeWorkers, 2);
      gates[name].resolve(); await turn();
    }
    await work; assert.deepEqual(builds, ['one', 'two']); assert.equal(created, 1); assert.equal(finalized, 1); assert.equal(persisted, true);
    assert.equal(context.budget.summary().peakWorkers, 2);
  } finally { for (const gate of Object.values(gates)) gate.resolve(); await Promise.allSettled([work]); }
});

test('targeted stage failures stop later phases, finalize once and never persist', async t => {
  const order = ['lint', 'build-stage', 'packing', 'consumers', 'type:one', 'type:two', 'scripts', 'coverage'];
  for (const failed of order) await t.test(failed, async child => {
    const fixture = await stageFixture(child), calls = [], failure = new Error(`failed ${failed}`);
    let created = 0, finalized = 0, persisted = false;
    const context = { budget: createTestWorkerBudget({ limit: 2 }), finalize: async () => { finalized++; } };
    const phase = async name => { calls.push(name); if (name === failed) throw failure; };
    await assert.rejects(fixture.runPackages({ fingerprint: {}, model: { packages: fixture.packages }, packageNames: ['one', 'two'],
      state: {}, tarballDigests: fixture.tarballDigests,
      run: async args => { if (args.at(-1) === 'lint') await phase('lint'); if (args.at(-1) === 'typecheck') await phase(`type:${args[1]}`); },
      prepare: async ({ build }) => { await phase('build-stage'); await build(); },
      createContext: async () => { created++; return context; },
      targetedVerify: async () => { await phase('packing'); await phase('consumers'); return { targetTarballs: fixture.targetTarballs }; },
      scriptTests: async () => { await phase('scripts'); }, coverage: async () => { await phase('coverage'); },
      persist: async () => { persisted = true; },
    }), error => error === failure);
    assert.deepEqual(calls, order.slice(0, order.indexOf(failed) + 1));
    assert.equal(finalized, created); assert.equal(finalized, order.indexOf(failed) > 1 ? 1 : 0); assert.equal(persisted, false);
    if (created) assert.equal(context.budget.summary().failed, true);
  });
});
