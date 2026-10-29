import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { createTestRunContext } from '../test-run-context.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const fixture = async (t, ceiling) => {
  const parent = resolve(repositoryRoot, '.tmp/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'worker-ceiling-')), events = resolve(root, 'events.jsonl');
  await writeFile(events, '');
  const originals = Object.fromEntries(['FORGE_CHECK_WORKER_EVENTS', 'FORGE_CHECK_WORKER_CEILING'].map(key => [key, process.env[key]]));
  process.env.FORGE_CHECK_WORKER_EVENTS = events;
  process.env.FORGE_CHECK_WORKER_CEILING = String(ceiling);
  const contexts = [];
  t.after(async () => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    for (const path of [...contexts.map(value => value.root), root]) {
      const inside = relative(await realpath(resolve(repositoryRoot, '.tmp')), await realpath(path));
      assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
      assert.equal((await lstat(path)).isSymbolicLink(), false);
      await rm(path, { recursive: true, force: true });
    }
  });
  return {
    async context(workers, runProcess = async () => { throw new Error('unexpected execution'); }) {
      const context = await createTestRunContext({ packages: [], workers, supervisor: {}, runProcess });
      contexts.push(context); return context;
    },
    async event(type, index, jobId = `foreign-${index}`) {
      await appendFile(events, `${JSON.stringify({ type, jobId, pid: 1000 + index, kind: index === 0 ? 'node-test' : 'vitest' })}\n`);
    },
  };
};

test('a one-slot nested context inherits the eight-slot global audit including its parent and siblings', async t => {
  const value = await fixture(t, 8);
  let environment;
  const context = await value.context(1, async spec => {
    environment = spec.env; await mkdir(spec.logRoot, { recursive: true });
    await writeFile(resolve(spec.logRoot, 'stdout.log'), ''); await writeFile(resolve(spec.logRoot, 'stderr.log'), '');
    return { jobId: 'owned' };
  });
  for (let index = 0; index < 8; index++) await value.event('start', index);
  await context.run({ name: 'injected child', command: 'never-executed' });
  assert.equal(environment.FORGE_CHECK_TEST_WORKERS, '1');
  assert.equal(environment.FORGE_CHECK_WORKER_CEILING, '8');
  const summary = await context.finalize();
  assert.equal(summary.observedPeakWorkers, 8); assert.equal(summary.observedWorkerLimit, 8);
  assert.deepEqual(summary.remainingWorkers, []);
});

test('a ninth global worker fails even when all events belong to other scopes', async t => {
  const value = await fixture(t, 8), context = await value.context(1);
  for (let index = 0; index < 9; index++) await value.event('start', index);
  for (let index = 0; index < 9; index++) await value.event('finish', index);
  await assert.rejects(context.finalize(), /worker.*ceiling/u);
});

test('owned workers must close even when their peak is below the global ceiling', async t => {
  const value = await fixture(t, 8);
  const context = await value.context(1, async spec => {
    await mkdir(spec.logRoot, { recursive: true });
    await writeFile(resolve(spec.logRoot, 'stdout.log'), ''); await writeFile(resolve(spec.logRoot, 'stderr.log'), '');
    return { jobId: 'owned' };
  });
  await context.run({ name: 'injected unclosed child', command: 'never-executed' });
  await value.event('start', 0, 'owned');
  await assert.rejects(context.finalize(), /worker.*closure/u);
  const summary = JSON.parse(await readFile(resolve(context.root, 'summary.json'), 'utf8'));
  assert.equal(summary.remainingWorkers.length, 1);
});

test('nested local allocation cannot exceed the inherited global ceiling', async t => {
  const value = await fixture(t, 2);
  await assert.rejects(value.context(4), /worker.*ceiling/u);
});
