import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { git, managedFixture } from './helpers/managed-fixture.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

it('内部 Git 维护留在前台且不改写仓库原有配置', async () => {
  const fixture = await managedFixture(); fixtures.push(fixture);
  git(fixture.cwd, 'config', 'maintenance.auto', 'true');
  git(fixture.cwd, 'config', 'maintenance.autoDetach', 'true');
  git(fixture.cwd, 'config', 'gc.autoDetach', 'true');

  expect(await fixture.execution.git(['config', '--bool', '--get', 'maintenance.autoDetach'])).toBe('false');
  const chunks: Buffer[] = [];
  await fixture.execution.streamGit(['config', '--bool', '--get', 'gc.autoDetach'], chunk => chunks.push(Buffer.from(chunk)));
  expect(Buffer.concat(chunks).toString('utf8').trim()).toBe('false');
  expect(await fixture.execution.git(['config', '--bool', '--get', 'maintenance.auto'])).toBe('true');

  const trace = resolve(fixture.root, 'git-trace.json');
  vi.stubEnv('GIT_TRACE2_EVENT', trace);
  vi.stubEnv('GIT_TRACE2_ENV_VARS', '');
  vi.stubEnv('GIT_TRACE2_CONFIG_PARAMS', '');
  await fixture.execution.git(['fetch', '--no-tags', 'origin', 'dev']);
  const events = (await readFile(trace, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line) as { event?: string; argv?: string[] });
  const children = events.filter(event => event.event === 'child_start').map(event => event.argv ?? []);
  // 新版 Git 使用 maintenance，旧版使用 gc；两者的真实执行配置都必须禁止脱离前台。
  const maintenance = children.filter(args => args.includes('maintenance') && args.includes('--auto'));
  if (git(fixture.cwd, '--list-cmds=builtins').split(/\s+/u).includes('maintenance')) {
    const help = spawnSync('git', ['maintenance', 'run', '-h'], { cwd: fixture.cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    expect([0, 129]).toContain(help.status);
    const supportsDetach = /--(?:\[no-\])?detach/u.test(help.stdout + help.stderr);
    expect(maintenance.length).toBeGreaterThan(0);
    for (const args of maintenance) {
      if (supportsDetach) expect(args).toContain('--no-detach');
      expect(args).not.toContain('--detach');
    }
  } else expect(children.some(args => args.includes('gc') && args.includes('--auto'))).toBe(true);

  expect(git(fixture.cwd, 'config', '--bool', '--get', 'maintenance.autoDetach')).toBe('true');
  expect(git(fixture.cwd, 'config', '--bool', '--get', 'gc.autoDetach')).toBe('true');
});
