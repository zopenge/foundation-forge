import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { runWindowsFixtureHost } from './windows-fixture-host.mjs';
import { assertNestedGitResult } from '../fixtures/nested-git.mjs';

// 用户批准仅false负例复用本次自有隐藏控制台；不再声称覆盖Git新建可见控制台。
export async function runIsolatedNestedGit({ iterations = 12, timeoutMs = 170_000 } = {}) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/nested-git-isolated');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'fixture-'));
  try {
    const resultPath = resolve(root, 'result.json'), requestPath = resolve(root, 'request.json');
    await writeFile(requestPath, JSON.stringify({ iterations, root, result: resultPath }), { flag: 'wx' });
    const host = await runWindowsFixtureHost({ executable: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/nested-git.mjs', import.meta.url)), 'host', requestPath], cwd: process.cwd(), timeoutMs });
    // 启动器已确认自己的Job为空并释放所有句柄；文件缺失、截断、少记录仍判失败。
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(host.empty, true); assert.equal(host.exitCode, 0);
    assert.equal(result.pid, host.pid); assert.equal(result.rows.length, iterations);
    assert.equal(result.console.visible, false); assert.notEqual(result.console.hwnd, '0');
    for (const [attempt, row] of result.rows.entries()) {
      assert.equal(row.attempt, attempt); assert.equal(row.windowsHide, false);
      assert.equal(row.child.windowsHide, false); assert.equal(row.child.console.hwnd, result.console.hwnd);
      assert.equal(row.child.console.visible, false); assert.equal(row.child.console.preservedStandardHandles, true);
      assert.equal(row.child.console.stdoutPipe, true); assert.equal(row.child.console.stderrPipe, true);
      assertNestedGitResult(row);
    }
    return { ...host, ...result };
  } catch (error) {
    const details = await readFile(resolve(root, 'failure.json'), 'utf8').catch(() => undefined);
    if (details) throw new AggregateError([error], details, { cause: error });
    throw error;
  } finally { await rm(root, { recursive: true, force: true }); }
}
