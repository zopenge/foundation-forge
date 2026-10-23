import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows 原生进程测试独占本包的文件执行槽，避免身份探测互相争用。
    ...(process.platform === 'win32' ? { maxWorkers: 1 } : {}),
    coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] },
  },
});
