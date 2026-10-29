import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { createTestRunContext } from './test-run-context.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const runScriptTestSuite = async (context, { files: selected } = {}) => {
  const directory = resolve(repositoryRoot, 'scripts/tests');
  const available = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort().map(name => resolve(directory, name));
  const files = selected ? selected.map(path => resolve(repositoryRoot, path)) : available;
  if (!files.length || files.some(path => !available.includes(path)) || new Set(files).size !== files.length) throw new Error('QUICK_SCRIPT_SELECTION_INVALID');
  // 每组预约父测试CLI和一个既有嵌套worker；单槽模式沿用原有嵌套例外。
  const workers = Math.min(2, context.budget.limit);
  const groups = Array.from({ length: Math.min(files.length, Math.max(1, Math.floor(context.budget.limit / workers))) }, () => []);
  for (const [index, file] of files.entries()) groups[index % groups.length].push(file);
  const failures = []; let cancelling;
  const results = await Promise.allSettled(groups.map((group, index) => context.budget.run({ name: 'test:scripts', workers }, async lease => {
    // 组内继续逐文件隔离，预约持续到整个owned Job及输出关闭。
    return context.execute({ name: groups.length === 1 ? 'test:scripts' : `test:scripts ${index + 1}/${groups.length}`, nestedWorkerLimit: 1,
      command: process.execPath, cwd: repositoryRoot, env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      args: [fileURLToPath(new URL('./run-script-test-worker.mjs', import.meta.url)), ...group] }, lease);
  }).catch(error => {
    if (!failures.includes(error)) failures.push(error);
    // 首败立即撤销其他组；等全部活动Job收尾后才交付失败，不隐藏二次收尾错误。
    cancelling ??= Promise.resolve().then(() => context.cancel?.(failures[0])).catch(cleanup => {
      if (!failures.includes(cleanup)) failures.push(cleanup);
    });
    throw error;
  })));
  await cancelling;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'script groups failed during execution or cleanup', { cause: failures[0] });
  return results.map(result => result.value);
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let context;
  try {
    const model = await discoverWorkspacePackageModel({ repositoryRoot });
    context = await createTestRunContext({ packages: model.packages });
    await runScriptTestSuite(context);
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
  finally { try { await context?.finalize(); } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; } }
}
