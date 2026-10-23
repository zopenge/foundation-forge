import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000,
  // Windows 原生身份探测与真实子进程 fixture 共用宿主资源，限制文件并发。
  ...(process.platform === 'win32' ? { maxWorkers: 2 } : {}),
  coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] } } });
