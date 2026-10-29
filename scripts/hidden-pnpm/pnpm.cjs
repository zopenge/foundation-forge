// 保持 CommonJS 主入口和 pnpm.cjs 文件名，保留 pnpm 原有 lifecycle/self-invocation 语义。
void import('./runtime.mjs').then(({ runHiddenPnpm }) => runHiddenPnpm()).catch(error => {
  globalThis.process.stderr.write(String(error?.stack ?? error) + '\n');
  globalThis.process.exitCode = 1;
});
