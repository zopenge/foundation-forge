import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import test from 'node:test';

import { runFullCheck } from '../check-full.mjs';

const pending = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('full check waits for package validation before coverage and starts built checks after build', async () => {
  const gates = Object.fromEntries([
    'lint', 'test:scripts', 'test:coverage', 'typecheck:built', 'packages:check-cycles:built',
  ].map((name) => [name, pending()]));
  const build = pending();
  const pack = pending();
  const started = [];
  const work = runFullCheck({
    run: (name) => { started.push(name); return gates[name].promise; },
    verify: async ({ onBuilt }) => {
      started.push('pack:check');
      await build.promise;
      onBuilt();
      await pack.promise;
    },
  });
  assert.deepEqual(started, ['lint', 'test:scripts', 'pack:check']);
  build.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.slice(3), [
    'typecheck:built', 'packages:check-cycles:built',
  ]);
  assert.equal(started.includes('test:coverage'), false);
  for (const [name, gate] of Object.entries(gates)) {
    if (name !== 'test:coverage') gate.resolve();
  }
  pack.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.at(-1), 'test:coverage');
  gates['test:coverage'].resolve();
  await work;
});

test('full check reports failure after all active checks drain', async () => {
  const pack = pending();
  const started = [];
  const work = runFullCheck({
    run: (name) => {
      started.push(name);
      if (name === 'lint') return Promise.reject(new Error('lint failed'));
      return Promise.resolve();
    },
    verify: async ({ onBuilt }) => { onBuilt(); await pack.promise; },
  });
  let completed = false;
  work.finally(() => { completed = true; }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  pack.resolve();
  await assert.rejects(work, /lint failed/u);
  assert.equal(completed, true);
  assert.equal(started.includes('packages:check-cycles:built'), true);
  assert.equal(started.includes('test:coverage'), false);
});
