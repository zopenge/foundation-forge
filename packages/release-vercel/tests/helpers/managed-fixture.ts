import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ReleaseConfig } from '../../src/contracts.js';
import { Execution } from '../../src/node/execution.js';

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, shell: false, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
export async function managedFixture() {
  const base = resolve(import.meta.dirname, '../../../../.tmp/managed-release-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'r-'));
  const cwd = resolve(root, 'source 空间 with spaces');
  const remote = resolve(root, 'remote.git');
  git(root, 'init', '--bare', remote); git(root, 'init', '-b', 'dev', cwd);
  git(cwd, 'config', 'user.email', 'fixture@example.invalid'); git(cwd, 'config', 'user.name', 'Fixture');
  git(cwd, 'remote', 'add', 'origin', remote);
  const config: ReleaseConfig = {
    schemaVersion: 2, source: { mode: 'managed-commit', slotPath: '.tmp/release-slot', maxBytes: 2 ** 31,
      minFreeBytes: 5 * 2 ** 30, sampleIntervalMs: 250, install: { packageManager: 'pnpm' }, prepare: [] },
    git: { remote: 'origin', repository: remote, developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [{ command: 'node', args: ['-e', 'process.stdout.write(process.cwd())'] }],
    acceptance: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
    buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 15_000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 },
  };
  await writeFile(resolve(cwd, '.gitignore'), '.tmp/\nnode_modules/\n');
  await writeFile(resolve(cwd, 'package.json'), JSON.stringify({ name: 'managed-fixture', private: true, packageManager: 'pnpm@10.33.2' }));
  await writeFile(resolve(cwd, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(resolve(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
  await writeFile(resolve(cwd, 'release.config.json'), JSON.stringify(config));
  await writeFile(resolve(cwd, 'source.txt'), 'initial\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  git(cwd, 'push', 'origin', 'HEAD:dev', 'HEAD:main'); const initial = git(cwd, 'rev-parse', 'HEAD');
  const commit = () => { git(cwd, 'add', '-u'); git(cwd, 'commit', '-m', 'candidate'); return git(cwd, 'rev-parse', 'HEAD'); };
  await writeFile(resolve(cwd, 'source.txt'), 'candidate\n'); const sha = commit();
  const execution = new Execution(cwd, config, undefined, []);
  return { root, cwd, remote, config, initial, sha, commit, execution,
    ref: (branch: string) => git(root, '--git-dir', remote, 'rev-parse', branch),
    dispose: async () => {
      let target: string;
      try { target = await realpath(root); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
      const contained = relative(base, target);
      if (!contained || contained === '..' || contained.startsWith('..\\') || contained.startsWith('../') || isAbsolute(contained)) throw new Error('fixture cleanup escaped its owned base');
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } };
}
