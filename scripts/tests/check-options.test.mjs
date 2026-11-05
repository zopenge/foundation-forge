import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import test from 'node:test';

const options = await import('../check-options.mjs').catch(error => ({ error }));
const gib = 2 ** 30;
const resources = () => ({ cpus: 8, freeMemory: 12 * gib, freeDisk: 20n * 1024n ** 3n });
const parse = async (args, env, readResources = resources) => {
  assert.ifError(options.error);
  return options.resolveCheckOptions(args, { env, resources: readResources });
};

test('normal quick, full and serial modes retain their scope without probing fast resources', async () => {
  for (const [args, expected, workers] of [
    [[], { quick: false, full: false }, '2'],
    [['--quick'], { quick: true, full: false }, '2'],
    [['--full'], { quick: false, full: true }, '2'],
    [['--full', '--serial'], { quick: false, full: true }, '1'],
  ]) {
    const env = { FORGE_CHECK_TEST_WORKERS: '2' };
    assert.deepEqual(await parse(args, env, () => { throw new Error('must not read fast resources'); }), expected);
    assert.equal(env.FORGE_CHECK_TEST_WORKERS, workers);
  }
});

test('fast full selects eight workers only after the resource preflight succeeds', async () => {
  for (const env of [{}, { FORGE_CHECK_TEST_WORKERS: '8' }]) {
    assert.deepEqual(await parse(['--full', '--fast'], env), { quick: false, full: true });
    assert.equal(env.FORGE_CHECK_TEST_WORKERS, '8');
  }
});

test('fast mode never overrides an explicit lower worker limit', async () => {
  const env = { FORGE_CHECK_TEST_WORKERS: '2' }; let probed = false;
  await assert.rejects(parse(['--full', '--fast'], env, () => { probed = true; return resources(); }), /FAST_CHECK_BUDGET_CONFLICT/u);
  assert.equal(env.FORGE_CHECK_TEST_WORKERS, '2'); assert.equal(probed, false);
});

test('invalid or conflicting CLI modes cannot start a fast full check', async () => {
  for (const args of [['--fast'], ['--quick', '--fast'], ['--full', '--fast', '--serial'],
    ['--full', '--quick'], ['--full', '--full'], ['--serial'], ['--full', '--unknown']]) {
    const env = {};
    await assert.rejects(parse(args, env), /CHECK_ARGUMENT_INVALID/u);
    assert.deepEqual(env, {});
  }
});

test('insufficient or unprovable fast resources reject without changing the worker configuration', async () => {
  for (const changed of [{ cpus: 7 }, { cpus: NaN }, { freeMemory: 12 * gib - 1 },
    { freeMemory: Infinity }, { freeDisk: 20n * 1024n ** 3n - 1n }, { freeDisk: 20 * gib }]) {
    const env = {};
    await assert.rejects(parse(['--full', '--fast'], env, () => ({ ...resources(), ...changed })), /FAST_CHECK_RESOURCES/u);
    assert.deepEqual(env, {});
  }
});

test('the real fast CLI refuses a lower declared budget before starting checks', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/check-runner.mjs', '--full', '--fast'], {
    cwd: resolve(import.meta.dirname, '../..'), env: { ...process.env, FORGE_CHECK_TEST_WORKERS: '2' },
    windowsHide: true, timeout: 5000,
  }), error => error.code === 1 && /FAST_CHECK_BUDGET_CONFLICT/u.test(error.stderr));
});
