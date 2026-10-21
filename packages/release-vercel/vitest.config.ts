import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000,
  coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] } } });
