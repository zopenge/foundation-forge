import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] },
  },
});
