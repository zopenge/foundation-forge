import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: true,
    maxWorkers: 6,
    testTimeout: 30_000,
    coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] },
  },
});
