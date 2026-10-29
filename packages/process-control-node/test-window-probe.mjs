import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { ensureTestTemporaryDirectory } from '../../scripts/test-temporary-directory.mjs';
import { createTestRunContext } from '../../scripts/test-run-context.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

// 最小有效 Git 数据由 fixture 自行生成，不额外启动准备进程或复制 checkout。
export const prepareWindowProbeFixture = async directory => {
  await ensureTestTemporaryDirectory(repositoryRoot, directory);
  const git = resolve(directory, '.git'); await mkdir(resolve(git, 'objects'), { recursive: true });
  await mkdir(resolve(git, 'refs/heads'), { recursive: true }); await mkdir(resolve(git, 'refs/tags'), { recursive: true });
  const object = async (type, body) => {
    const bytes = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const oid = createHash('sha1').update(bytes).digest('hex');
    const parent = resolve(git, 'objects', oid.slice(0, 2)); await mkdir(parent, { recursive: true });
    await writeFile(resolve(parent, oid.slice(2)), deflateSync(bytes)); return oid;
  };
  const worker = fileURLToPath(new URL('../../scripts/fixtures/window-flash-probe-worker.mjs', import.meta.url));
  const contents = `${JSON.stringify({ private: true, scripts: { probe: 'pnpm run probe:git',
    'probe:git': `node "${worker}" "${directory}" "${resolve(directory, '.git/trace.jsonl')}"` } })}\n`;
  await writeFile(resolve(directory, 'package.json'), contents);
  const blob = await object('blob', Buffer.from(contents));
  const tree = await object('tree', Buffer.concat([Buffer.from('100644 package.json\0'), Buffer.from(blob, 'hex')]));
  const sha = await object('commit', Buffer.from(`tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nwindow fixture\n`));
  await writeFile(resolve(git, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(resolve(git, 'refs/heads/main'), `${sha}\n`);
  await writeFile(resolve(git, 'refs/tags/window-fixture@0.0.0'), `${sha}\n`);
  await writeFile(resolve(git, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n');
  return sha;
};

const main = async name => {
  if (process.platform !== 'win32' || !/^[a-z][a-z0-9-]{0,24}$/u.test(name ?? '')) throw new Error('Windows probe requires a short run name');
  const evidence = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, '.tmp/windows-flash-investigation'));
  const reportPath = resolve(evidence, `${name}.json`);
  const report = { name, startedAt: new Date().toISOString(), workBudgetMs: 5_000, cleanupBudgetMs: 10_000, stages: [] };
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, { flag: 'wx' });
  const controller = new globalThis.AbortController(); let context, observer, workTimer, result, fixture, identity;
  const cancel = reason => {
    if (controller.signal.aborted) return;
    report.cancel = { reason, at: new Date().toISOString() };
    try { if (report.cancelFile) writeFileSync(report.cancelFile, `${JSON.stringify(report.cancel)}\n`); }
    catch (error) { report.cancelMarkerError = String(error.message ?? error).slice(0, 256); }
    controller.abort(new Error(reason));
  };
  try {
    // 纯夹具生成不依赖构建产物；真实入口的加载失败也必须写入收据。
    const { createWindowsTestWindowObserver } = await import('./test-window-observer.mjs');
    observer = await createWindowsTestWindowObserver({
      onFlash: () => cancel('visible-window'), onGap: reason => cancel(reason),
      protectedPids: JSON.parse(process.env.FORGE_WINDOW_PROTECTED_PIDS ?? '[]') });
    controller.signal.throwIfAborted();
    context = await createTestRunContext({ packages: [{ packageRoot: fileURLToPath(new URL('./', import.meta.url)) }],
      workers: 1, signal: controller.signal }); report.contextRoot = context.root;
    fixture = resolve(context.root, 'fixture'); report.expectedSha = await prepareWindowProbeFixture(fixture);
    identity = await lstat(fixture, { bigint: true }); report.fixtureRealPath = await realpath(fixture);
    report.cancelFile = resolve(context.root, 'cancel.request');
    report.workStartedAt = new Date().toISOString();
    workTimer = setTimeout(() => cancel('work-budget'), 5_000);
    try {
      result = await context.run({ name: 'window pnpm/nested/local-git probe', workers: 1, command: process.execPath,
        args: [resolve(repositoryRoot, 'scripts/hidden-pnpm/pnpm.cjs'), '--dir', fixture, 'run', 'probe'], cwd: fixture,
        env: { ...process.env, FORGE_CHECK_CANCEL_FILE: report.cancelFile } });
    } catch (error) { result = error.result; report.error = String(error.message).slice(0, 2048); }
    finally { clearTimeout(workTimer); }
    report.job = result; report.summary = await context.finalize();
    report.workAndCleanupMs = Date.now() - Date.parse(report.workStartedAt);
    try { report.stages = (await readFile(resolve(fixture, '.git/trace.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } catch (error) {
    report.error ??= String(error.stack ?? error).slice(0, 2048);
    report.observation ??= error.observation;
    if (context && !report.summary) { await context.cancel(error); report.summary = await context.finalize(); }
  } finally {
    clearTimeout(workTimer);
    const cleanupError = (phase, error) => { (report.cleanupErrors ??= []).push({ phase, error: String(error.message ?? error).slice(0, 256) }); };
    try { if (observer) report.observation = await observer.close(); } catch (error) { cleanupError('observer', error); }
    try {
      if (fixture && identity && report.job?.closure?.empty === true) {
        const current = await lstat(fixture, { bigint: true });
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino
          && await realpath(fixture) === report.fixtureRealPath) { await rm(fixture, { recursive: true }); report.fixtureRemoved = true; }
        else cleanupError('fixture', new Error('fixture identity changed'));
      }
    } catch (error) { cleanupError('fixture', error); }
    report.finishedAt = new Date().toISOString();
    report.status = !report.cleanupErrors?.length && !report.cancelMarkerError && report.observation?.ready && report.observation.gaps.length === 0 && report.job?.closure?.empty === true
      && report.summary?.activeWorkers === 0 && report.summary.remainingWorkers.length === 0 && report.fixtureRemoved
      ? report.observation.visibleWindows.length ? 'visible-window-captured' : report.error ? 'failed' : 'not-reproduced' : 'unconfirmed';
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: report.status, reportPath, contextRoot: report.contextRoot,
      cancel: report.cancel, observation: report.observation, closure: report.job?.closure, summary: report.summary })}\n`);
    process.exitCode = report.status === 'visible-window-captured' ? 2 : report.status === 'not-reproduced' ? 3 : 1;
  }
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
