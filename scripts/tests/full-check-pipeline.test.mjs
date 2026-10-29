import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runFullCheck } from '../check-full.mjs';

const gate = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const fixture = (limit, calls, cancel = async () => {}) => ({ budget: { limit, stop: () => calls.push('stop') },
  cancel: async reason => { calls.push('cancel'); await cancel(reason); }, finalize: async () => { calls.push('finalize'); } });

test('an explicit wide budget runs lint after build and scripts, and completion still waits for lint', async () => {
  const original = process.env.FORGE_CHECK_TEST_WORKERS; process.env.FORGE_CHECK_TEST_WORKERS = '8';
  const calls = [], build = gate(), scripts = gate(), lint = gate(), context = fixture(8, calls);
  const work = runFullCheck({ run: async name => { calls.push(name); if (name === 'lint') await lint.promise; },
    createContext: async () => context,
    verify: async ({ onBuilt }) => { calls.push('build'); await build.promise; await onBuilt({ packages: [] }); },
    scriptTests: async () => { calls.push('scripts'); await scripts.promise; }, coverage: async () => { calls.push('coverage'); } });
  try {
    await setImmediate(); assert.deepEqual(calls, ['build']);
    build.resolve(); await setImmediate(); assert.ok(calls.includes('scripts')); assert.equal(calls.includes('lint'), false);
    scripts.resolve(); await setImmediate(); assert.ok(calls.includes('lint')); assert.ok(calls.includes('coverage'));
    assert.equal(calls.includes('finalize'), false);
  } finally {
    build.resolve(); scripts.resolve(); lint.resolve();
    try { await work; } finally { if (original === undefined) Reflect.deleteProperty(process.env, 'FORGE_CHECK_TEST_WORKERS'); else process.env.FORGE_CHECK_TEST_WORKERS = original; }
  }
  assert.equal(calls.at(-1), 'finalize');
});

test('a late lint failure cancels active tests and joins them before finalization', async () => {
  const original = process.env.FORGE_CHECK_TEST_WORKERS; process.env.FORGE_CHECK_TEST_WORKERS = '8';
  const calls = [], lint = gate(), coverage = gate(), failure = new Error('lint failed');
  const context = fixture(8, calls);
  const work = runFullCheck({ run: async name => { if (name === 'lint') { await lint.promise; throw failure; } },
    createContext: async () => context, verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); },
    scriptTests: async () => {}, coverage: async () => { calls.push('coverage'); await coverage.promise; } });
  const rejected = assert.rejects(work, error => error === failure);
  try {
    await setImmediate(); assert.ok(calls.includes('coverage'));
    lint.resolve(); await setImmediate(); assert.ok(calls.includes('cancel')); assert.equal(calls.includes('finalize'), false);
  } finally {
    lint.resolve(); coverage.resolve();
    try { await rejected; } finally { if (original === undefined) Reflect.deleteProperty(process.env, 'FORGE_CHECK_TEST_WORKERS'); else process.env.FORGE_CHECK_TEST_WORKERS = original; }
  }
  assert.equal(calls.at(-1), 'finalize');
});

test('post-build scripts overlap packing and static checks wait for scripts before overlapping coverage', async () => {
  const calls = [], lint = gate(), build = gate(), packing = gate(), scripts = gate(), coverage = gate(), types = gate();
  const context = fixture(8, calls);
  const work = runFullCheck({
    run: async name => { calls.push(name); if (name === 'lint') await lint.promise; if (name === 'typecheck:built') await types.promise; },
    verify: async ({ onBuilt }) => { calls.push('build'); await build.promise; assert.equal(await onBuilt({ packages: [] }), context); calls.push('packing'); await packing.promise; },
    createContext: async () => context,
    scriptTests: async () => { calls.push('scripts'); await scripts.promise; },
    coverage: async () => { calls.push('coverage'); await coverage.promise; },
  });
  try {
    await setImmediate(); assert.deepEqual(calls, ['lint']);
    lint.resolve(); await setImmediate(); assert.deepEqual(calls, ['lint', 'build']);
    build.resolve(); await setImmediate();
    assert.ok(calls.includes('scripts')); assert.equal(calls.includes('typecheck:built'), false);
    assert.equal(calls.includes('coverage'), false); assert.equal(calls.includes('finalize'), false);
    scripts.resolve(); await setImmediate(); assert.ok(calls.includes('coverage')); assert.ok(calls.includes('typecheck:built'));
    packing.resolve(); coverage.resolve(); await setImmediate(); assert.equal(calls.includes('finalize'), false);
  } finally { lint.resolve(); build.resolve(); scripts.resolve(); packing.resolve(); coverage.resolve(); types.resolve(); await work; }
  assert.equal(calls.at(-1), 'finalize'); assert.equal(calls.filter(value => value === 'finalize').length, 1);
});

test('one and two slot runs retain the serial phase order', async () => {
  for (const limit of [1, 2]) {
    const calls = [], packing = gate(), context = fixture(limit, calls);
    const work = runFullCheck({ run: async name => { calls.push(name); }, createContext: async () => context,
      verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); calls.push('packing'); await packing.promise; },
      scriptTests: async () => { calls.push('scripts'); }, coverage: async () => { calls.push('coverage'); } });
    try { await setImmediate(); assert.deepEqual(calls, ['lint', 'packing']); }
    finally { packing.resolve(); await work; }
    assert.deepEqual(calls, ['lint', 'packing', 'typecheck:built', 'packages:check-cycles:built', 'scripts', 'coverage', 'finalize']);
  }
});

test('a background failure cancels workers immediately and still joins packing and cancellation before finalize', async () => {
  const calls = [], packing = gate(), cleanup = gate(), failure = new Error('scripts failed');
  const context = fixture(8, calls, async () => { await cleanup.promise; });
  const work = runFullCheck({ run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); await packing.promise; calls.push('packing-closed'); },
    scriptTests: async () => { throw failure; }, coverage: async () => { calls.push('coverage'); } });
  const rejected = assert.rejects(work, error => error === failure);
  try {
    await setImmediate(); assert.ok(calls.includes('cancel')); assert.equal(calls.includes('finalize'), false);
    packing.resolve(); await setImmediate(); assert.equal(calls.includes('finalize'), false);
  } finally { packing.resolve(); cleanup.resolve(); await rejected; }
  assert.equal(calls.includes('coverage'), false); assert.equal(calls.at(-1), 'finalize');
});

test('packing failure drains already running coverage and preserves both errors', async () => {
  const calls = [], packing = gate(), coverage = gate(), cancelled = gate();
  const first = new Error('packing failed'), second = new Error('coverage closed after failure');
  const context = fixture(8, calls, async () => { cancelled.resolve(); });
  const work = runFullCheck({ run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); await packing.promise; throw first; },
    scriptTests: async () => {}, coverage: async () => { calls.push('coverage'); await coverage.promise; throw second; } });
  const rejected = assert.rejects(work, error => error instanceof AggregateError && error.cause === first
    && error.errors.includes(first) && error.errors.includes(second));
  try {
    await setImmediate(); assert.ok(calls.includes('coverage'));
    packing.resolve(); await cancelled.promise; assert.equal(calls.includes('finalize'), false);
  } finally { packing.resolve(); coverage.resolve(); await rejected; }
  assert.equal(calls.at(-1), 'finalize');
});
