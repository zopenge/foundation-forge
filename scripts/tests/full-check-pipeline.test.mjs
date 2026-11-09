import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runFullCheck } from '../check-full.mjs';

const gate = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const fixture = (limit, calls, cancel = async () => {}) => ({ budget: { limit, stop: () => calls.push('stop') },
  cancel: async reason => { calls.push('cancel'); await cancel(reason); }, finalize: async () => { calls.push('finalize'); } });
const serialEnvironment = t => {
  const previous = process.env.FORGE_CHECK_TEST_WORKERS;
  process.env.FORGE_CHECK_TEST_WORKERS = '1';
  t.after(() => { if (previous === undefined) Reflect.deleteProperty(process.env, 'FORGE_CHECK_TEST_WORKERS'); else process.env.FORGE_CHECK_TEST_WORKERS = previous; });
};

test('an explicit wide budget runs lint after build and scripts, and completion still waits for lint', async () => {
  const original = process.env.FORGE_CHECK_TEST_WORKERS; process.env.FORGE_CHECK_TEST_WORKERS = '8';
  const calls = [], build = gate(), scripts = gate(), lint = gate(), context = fixture(8, calls);
  const work = runFullCheck({ run: async name => { calls.push(name); if (name === 'lint') await lint.promise; },
    createContext: async () => context,
    verify: async ({ onBuilt, onConsumerReady }) => { calls.push('build'); await build.promise; await onBuilt({ packages: [] }); await onConsumerReady(); },
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
    createContext: async () => context, verify: async ({ onBuilt, onConsumerReady }) => { await onBuilt({ packages: [] }); await onConsumerReady(); },
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

test('post-build scripts overlap packing and static checks wait for scripts before overlapping coverage', async t => {
  serialEnvironment(t);
  const calls = [], lint = gate(), build = gate(), packing = gate(), scripts = gate(), coverage = gate(), types = gate();
  const context = fixture(4, calls);
  const work = runFullCheck({
    run: async name => { calls.push(name); if (name === 'lint') await lint.promise; if (name === 'typecheck:built') await types.promise; },
    verify: async ({ onBuilt, onConsumerReady }) => { calls.push('build'); await build.promise; assert.equal(await onBuilt({ packages: [] }), context); await onConsumerReady(); calls.push('packing'); await packing.promise; },
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

test('one and two slot runs retain the serial phase order', async t => {
  serialEnvironment(t);
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

test('a background failure cancels workers immediately and still joins packing and cancellation before finalize', async t => {
  serialEnvironment(t);
  const calls = [], packing = gate(), cleanup = gate(), failure = new Error('scripts failed');
  const context = fixture(4, calls, async () => { await cleanup.promise; });
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

test('packing failure drains already running coverage and preserves both errors', async t => {
  serialEnvironment(t);
  const calls = [], packing = gate(), coverage = gate(), cancelled = gate();
  const first = new Error('packing failed'), second = new Error('coverage closed after failure');
  const context = fixture(4, calls, async () => { cancelled.resolve(); });
  const work = runFullCheck({ run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt, onConsumerReady }) => { await onBuilt({ packages: [] }); await onConsumerReady(); await packing.promise; throw first; },
    scriptTests: async () => {}, coverage: async () => { calls.push('coverage'); await coverage.promise; throw second; } });
  const rejected = assert.rejects(work, error => error instanceof AggregateError && error.cause === first
    && error.errors.includes(first) && error.errors.includes(second));
  try {
    await setImmediate(); assert.ok(calls.includes('coverage'));
    packing.resolve(); await cancelled.promise; assert.equal(calls.includes('finalize'), false);
  } finally { packing.resolve(); coverage.resolve(); await rejected; }
  assert.equal(calls.at(-1), 'finalize');
});

for (const limit of [4, 6]) test(`${limit} slots wait for both scripts and consumer installation before coverage`, async () => {
  const original = process.env.FORGE_CHECK_TEST_WORKERS;
  process.env.FORGE_CHECK_TEST_WORKERS = String(limit);
  try {
    for (const first of ['scripts', 'installation']) {
      const calls = [], scripts = gate(), installation = gate(), packing = gate(), context = fixture(limit, calls);
      const work = runFullCheck({ run: async () => {}, createContext: async () => context,
        verify: async ({ onBuilt, onConsumerReady }) => {
          await onBuilt({ packages: [] }); await installation.promise; await onConsumerReady(); await packing.promise;
        }, scriptTests: async () => { calls.push('scripts'); await scripts.promise; },
        coverage: async () => { calls.push('coverage'); } });
      try {
        await setImmediate(); assert.ok(calls.includes('scripts'));
        (first === 'scripts' ? scripts : installation).resolve();
        await setImmediate(); assert.equal(calls.includes('coverage'), false);
        (first === 'scripts' ? installation : scripts).resolve();
        await setImmediate(); assert.equal(calls.filter(call => call === 'coverage').length, 1);
        assert.equal(calls.includes('finalize'), false);
      } finally { scripts.resolve(); installation.resolve(); packing.resolve(); await work; }
      assert.equal(calls.at(-1), 'finalize');
    }
  } finally { if (original === undefined) Reflect.deleteProperty(process.env, 'FORGE_CHECK_TEST_WORKERS'); else process.env.FORGE_CHECK_TEST_WORKERS = original; }
});

test('missing consumer readiness fails before the real pre-cleanup drain can wait forever', async t => {
  serialEnvironment(t);
  const calls = [], context = fixture(4, calls);
  await assert.rejects(runFullCheck({ run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt, onBeforeCleanup }) => { await onBuilt({ packages: [] }); await onBeforeCleanup(); },
    scriptTests: async () => {}, coverage: async () => { calls.push('coverage'); },
  }), error => error.message === 'CONSUMER_READY_REQUIRED');
  assert.equal(calls.includes('coverage'), false);
  assert.equal(calls.filter(call => call === 'finalize').length, 1);
});

test('installation failure rejects the readiness wait and joins scripts and cancellation before finalize', async t => {
  serialEnvironment(t);
  const calls = [], installation = gate(), scripts = gate(), cleanup = gate(), failure = new Error('installation failed');
  const context = fixture(4, calls, async () => { await cleanup.promise; });
  const work = runFullCheck({ run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); await installation.promise; throw failure; },
    scriptTests: async () => { await scripts.promise; }, coverage: async () => { calls.push('coverage'); } });
  const rejected = assert.rejects(work, error => error === failure);
  try {
    await setImmediate(); installation.resolve(); await setImmediate();
    assert.ok(calls.includes('cancel')); assert.equal(calls.includes('finalize'), false);
    scripts.resolve(); await setImmediate(); assert.equal(calls.includes('coverage'), false);
    assert.equal(calls.includes('finalize'), false);
  } finally { installation.resolve(); scripts.resolve(); cleanup.resolve(); await rejected; }
  assert.equal(calls.at(-1), 'finalize');
});

test('external cancellation while awaiting installation never starts coverage and retains the exact reason', async t => {
  serialEnvironment(t);
  const calls = [], installation = gate(), cleanup = gate(), controller = new globalThis.AbortController();
  const failure = new Error('cancelled before install completed'), context = fixture(4, calls, async () => { await cleanup.promise; });
  const work = runFullCheck({ run: async () => {}, createContext: async () => context, signal: controller.signal,
    verify: async ({ onBuilt, onConsumerReady }) => { await onBuilt({ packages: [] }); await installation.promise; await onConsumerReady(); },
    scriptTests: async () => {}, coverage: async () => { calls.push('coverage'); } });
  const rejected = assert.rejects(work, error => error === failure);
  try {
    await setImmediate(); assert.equal(calls.includes('coverage'), false);
    controller.abort(failure); installation.resolve(); await setImmediate();
    assert.ok(calls.includes('cancel')); assert.equal(calls.includes('finalize'), false);
  } finally { controller.abort(failure); installation.resolve(); cleanup.resolve(); await rejected; }
  assert.equal(calls.at(-1), 'finalize');
});

test('common gates without coverage do not require consumer readiness for the background drain', async t => {
  serialEnvironment(t);
  const calls = [], context = fixture(4, calls);
  await runFullCheck({ run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt, onBeforeCleanup }) => { await onBuilt({ packages: [] }); await onBeforeCleanup(); },
    scriptTests: async () => { calls.push('scripts'); }, coverage: false });
  assert.ok(calls.includes('scripts')); assert.equal(calls.at(-1), 'finalize');
});

test('consumer readiness before build is rejected without starting any test context', async t => {
  serialEnvironment(t);
  const calls = [];
  await assert.rejects(runFullCheck({ run: async () => {},
    createContext: async () => { calls.push('context'); return fixture(4, calls); },
    verify: async ({ onConsumerReady }) => { await onConsumerReady(); },
    scriptTests: async () => { calls.push('scripts'); }, coverage: async () => { calls.push('coverage'); },
  }), error => error.message === 'CONSUMER_READY_BEFORE_BUILD');
  assert.deepEqual(calls, []);
});

test('duplicate consumer readiness keeps the first gate and still cancels and finalizes once', async t => {
  serialEnvironment(t);
  const calls = [], context = fixture(4, calls);
  await assert.rejects(runFullCheck({ run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt, onConsumerReady }) => { await onBuilt({ packages: [] }); await onConsumerReady(); await onConsumerReady(); },
    scriptTests: async () => {}, coverage: async () => {},
  }), error => error.message === 'CONSUMER_READY_DUPLICATE');
  assert.equal(calls.filter(call => call === 'cancel').length, 1);
  assert.equal(calls.filter(call => call === 'finalize').length, 1);
});
