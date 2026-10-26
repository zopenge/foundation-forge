import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { createTestRunContext } from './test-run-context.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const runScriptTestSuite = async context => {
  const directory = resolve(repositoryRoot, 'scripts/tests');
  const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort().map(name => resolve(directory, name));
  // 主Node测试worker逐文件执行；真实Vitest故障fixture最多再占一个被测worker。
  return context.budget.run({ name: 'test:scripts', workers: context.budget.limit }, async lease => {
    const results = [];
    // 每个文件一个CLI；首个失败停止后续文件，预约持续到当前作用域真正关闭。
    for (const file of files) results.push(await context.execute({ name: `test:scripts ${file}`, nestedWorkerLimit: 1,
      command: process.execPath, cwd: repositoryRoot, env: { ...process.env, NODE_TEST_CONTEXT: undefined, FORGE_NODE_TEST_FILE: file },
      args: ['--import', new URL('./node-test-worker-observer.mjs', import.meta.url).href, '--test', '--experimental-test-isolation=none', '--test-concurrency=1', file] }, lease));
    return results;
  });
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
