import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

/** 受控首消息失败使用真实tarball/原生收尾；默认与显式退休由未注入的公开CLI执行。 */
export async function verifyUnstartedConsumer({ cwd, binary, sha, execute }) {
  if (process.platform !== 'win32') return async () => {};
  const worker = spawnSync(process.execPath, ['--experimental-test-module-mocks', resolve(import.meta.dirname, 'unstarted-worker.mjs'), cwd],
    { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000 });
  if (worker.stderr) process.stderr.write(worker.stderr);
  assert.equal(worker.status, 0, worker.error?.message ?? worker.stdout);
  const failed = JSON.parse(worker.stdout);
  assert.equal(failed.candidateSha, sha); assert.equal(failed.processes?.status, 'unknown');
  const statePath = resolve(cwd, '.tmp/release-slot/state.json'), receiptPath = resolve(cwd, '.tmp/release-slot/latest-check.json');
  const state = await readFile(statePath), receipt = await readFile(receiptPath);
  const ordinary = spawnSync(process.execPath, [binary, 'retire', '--cwd', cwd, '--run-id', failed.runId],
    { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000 });
  if (ordinary.stderr) process.stderr.write(ordinary.stderr);
  assert.equal(ordinary.status, 1, ordinary.error?.message ?? ordinary.stdout);
  assert.equal(JSON.parse(ordinary.stdout).error?.details?.reason, 'SUBSEQUENT_BOOT_REQUIRED');
  const args = [binary, 'retire', '--cwd', cwd, '--run-id', failed.runId, '--abandon-unstarted'];
  const retired = JSON.parse(execute(cwd, process.execPath, args));
  assert.equal(retired.ok, true); assert.equal(retired.retirement?.cessation, 'recorded-empty-unstarted-scope');
  assert.equal(retired.retirement?.historicalVerification, 'unknown'); assert.equal(retired.processes?.status, 'unknown');
  assert.equal((await readFile(statePath)).equals(state), true); assert.equal((await readFile(receiptPath)).equals(receipt), true);
  await assert.rejects(readFile(resolve(cwd, '.tmp/release-slot/run.lock')), { code: 'ENOENT' });
  const archivePath = retired.retirement.archivePath, archived = await readFile(archivePath), evidence = JSON.parse(archived);
  assert.equal(evidence.snapshot.state, state.toString('utf8')); assert.equal(evidence.snapshot.check, receipt.toString('utf8'));
  assert.equal(evidence.final.observation.developmentRef.relation, 'unknown');
  assert.equal(JSON.parse(execute(cwd, process.execPath, args)).retirement?.cessation, 'recorded-empty-unstarted-scope');
  // 调用方随后运行既有公开SDK新尝试；旧归档必须在该新尝试之后仍逐字节保留。
  return async () => { assert.equal((await readFile(archivePath)).equals(archived), true); };
}
