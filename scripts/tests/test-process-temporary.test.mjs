import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { runTestProcess } from '../test-process-runner.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const temporaryBase = resolve(repositoryRoot, '.tmp/test-work');
const fixture = async t => {
  const base = resolve(repositoryRoot, '.tmp/tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'temporary-lifecycle-')), owned = [];
  t.after(async () => {
    // 替身未启动任何 OS 进程；只回收该测试实际取得的目录，不扫描历史运行。
    for (const path of owned) {
      const inside = relative(temporaryBase, resolve(path));
      assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
      await rm(path, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, owned };
};

for (const mode of ['success', 'failure', 'cancel', 'timeout', 'unconfirmed', 'replaced']) {
  test('Job 临时目录生命周期：' + mode, async t => {
    const f = await fixture(t), control = new globalThis.AbortController();
    const reason = Object.assign(new Error(mode), { name: mode === 'timeout' ? 'TimeoutError' : 'AbortError' });
    let temporary, disposed = false;
    const supervisor = { provider: { start: spec => {
      temporary = spec.environment.FORGE_CHECK_JOB_TEMP;
      assert.equal(typeof temporary, 'string', 'supervised command requires an owned temporary directory');
      f.owned.push(temporary);
      const ready = writeFile(resolve(temporary, 'fixture-data'), 'owned fixture');
      return {
        rootPid: Promise.resolve(123),
        bind: async () => {},
        authorize: async () => {
          await ready;
          if (mode === 'cancel' || mode === 'timeout') control.abort(reason);
        },
        terminate: async () => {},
        completion: ready.then(() => ({ exitCode: mode === 'failure' ? 1 : 0, signal: null,
          closure: { status: mode === 'unconfirmed' ? 'unknown' : 'closed', empty: mode !== 'unconfirmed' } })),
        dispose: async () => {
          await ready;
          assert.equal(await readFile(resolve(temporary, 'fixture-data'), 'utf8'), 'owned fixture');
          if (mode === 'replaced') {
            const original = temporary + '-original';
            await rename(temporary, original); f.owned.push(original);
            await mkdir(temporary); await writeFile(resolve(temporary, 'replacement'), 'preserve');
          }
          disposed = true;
        },
      };
    } }, reader: { readIdentity: async () => ({ status: 'FOUND', identity: { pid: 123, startToken: 'injected-instance' } }) } };
    const work = runTestProcess({ supervisor, name: 'temporary ' + mode, command: 'never-executed', logRoot: f.root,
      env: {}, signal: control.signal });
    let result;
    if (mode === 'success') result = await work;
    else await assert.rejects(work, error => {
      result = error.result;
      if (mode === 'cancel' || mode === 'timeout') assert.equal(error.cause, reason);
      return true;
    });
    assert.equal(disposed, true);
    assert.equal(result.temporary.path, temporary);
    const saved = JSON.parse(await readFile(resolve(f.root, 'process.json'), 'utf8'));
    assert.deepEqual(saved.temporary, result.temporary);
    if (mode === 'unconfirmed') {
      assert.equal(result.temporary.status, 'retained');
      assert.equal(result.temporary.reason, 'scope-closure-unconfirmed');
      assert.equal(await readFile(resolve(temporary, 'fixture-data'), 'utf8'), 'owned fixture');
    } else if (mode === 'replaced') {
      assert.equal(result.temporary.status, 'retained');
      assert.equal(result.error.phase, 'temporary-cleanup');
      assert.equal(await readFile(resolve(temporary, 'replacement'), 'utf8'), 'preserve');
      assert.equal(await readFile(resolve(temporary + '-original', 'fixture-data'), 'utf8'), 'owned fixture');
    } else {
      assert.equal(result.temporary.status, 'removed');
      await assert.rejects(lstat(temporary), { code: 'ENOENT' });
    }
  });
}
