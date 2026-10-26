import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000,
  // Windows 独立运行默认逐文件；仓库验收按包元数据显式分配，共享总预算最多2。
  ...(process.platform === 'win32' ? { maxWorkers: 1 } : {}),
  coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] } } });
