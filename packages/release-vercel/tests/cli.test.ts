import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const cli = resolve(import.meta.dirname, '../dist/cli.js');
it('reports invalid CLI arguments as JSON and exits 2', () => {
  for (const args of [[], ['upload'], ['status', '--sha', 'short'], ['publish', '--sha', 'a'.repeat(40)], ['check', '--unknown']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('ARGUMENT_INVALID');
  }
});
it('reports missing config as JSON and exits 1', () => {
  const result = spawnSync(process.execPath, [cli, 'check', '--config', 'missing-release-fixture.json'], { encoding: 'utf8', shell: false, windowsHide: true });
  expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe('CONFIG_READ');
});
