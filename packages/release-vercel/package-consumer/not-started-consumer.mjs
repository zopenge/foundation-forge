import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

/** 真实 tarball 的公开 SDK 取消，再用未注入的公开 CLI 验证正常恢复与历史不可改写。 */
export async function verifyNotStartedConsumer({ cwd, binary, sha, execute }) {
  const worker = spawnSync(process.execPath, ['--experimental-test-module-mocks',
    resolve(import.meta.dirname, 'not-started-worker.mjs'), cwd],
  { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000 });
  // 保留 Node 对测试模块注入的实验警告，不能静默屏蔽。
  if (worker.stderr) process.stderr.write(worker.stderr);
  assert.equal(worker.status, 0, worker.error?.message ?? worker.stdout);
  const report = JSON.parse(worker.stdout);
  assert.equal(report.candidateSha, sha); assert.equal(report.effects.developmentPush, 'not-attempted');
  assert.equal(report.effects.releasePush, 'not-attempted');
  const statePath = resolve(cwd, '.tmp/release-slot/state.json'), receiptPath = resolve(cwd, '.tmp/release-slot/latest-check.json');
  const state = await readFile(statePath), receipt = await readFile(receiptPath);
  assert.equal(JSON.parse(receipt).report.error.code, 'CANCELLED');
  const recovered = JSON.parse(execute(cwd, process.execPath, [binary, 'recover', '--cwd', cwd]));
  assert.equal(recovered.ok, true); assert.equal(recovered.command, 'recover'); assert.equal(recovered.candidateSha, sha);
  assert.equal(recovered.processes?.status, 'closed');
  assert.equal(recovered.steps.some(step => step.name === 'install' || step.name.startsWith('check:')), false);
  assert.equal((await readFile(statePath)).equals(state), true);
  assert.equal((await readFile(receiptPath)).equals(receipt), true);
}
