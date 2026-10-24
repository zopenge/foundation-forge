import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000,
  // Windows 原生身份探测与完整发布 fixture 共用宿主资源；保留用例内并发，逐文件执行。
  ...(process.platform === 'win32' ? { maxWorkers: 1 } : {}),
  coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] } } });
