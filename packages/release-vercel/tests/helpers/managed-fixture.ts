import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ReleaseConfig } from '../../src/contracts.js';
import { createManagedExecution } from '../../src/node/managed-execution.js';
import { git, prepareManagedFixtureHistory } from './managed-fixture-git.js';
import { ensureTestTemporaryDirectory } from '../../../../scripts/test-temporary-directory.mjs';

export { git } from './managed-fixture-git.js';
export async function managedFixture() {
  const repositoryRoot = resolve(import.meta.dirname, '../../../..');
  const repositoryTemporary = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, '.tmp'));
  const ownedTemporary = process.env.FORGE_CHECK_JOB_TEMP;
  if (ownedTemporary) {
    if (!isAbsolute(ownedTemporary)) throw new Error('managed fixture temporary root must be absolute');
    const inside = relative(repositoryTemporary, resolve(ownedTemporary));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('managed fixture temporary root escaped the repository');
  }
  const base = await ensureTestTemporaryDirectory(repositoryRoot, resolve(ownedTemporary ?? repositoryTemporary, 'managed-release-tests'));
  const root = await mkdtemp(resolve(base, 'r-'));
  const rootIdentity = await lstat(root, { bigint: true }), canonicalRoot = await realpath(root);
  const createdInside = relative(base, canonicalRoot);
  if (!createdInside || createdInside.startsWith('..') || isAbsolute(createdInside) || rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory())
    throw new Error('new fixture directory escaped its checked parent');
  const cwd = resolve(root, 'source 空间 with spaces');
  const remote = resolve(root, 'remote.git');
  const dispose = async () => {
    const current = await lstat(root, { bigint: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!current) return;
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino
      || await realpath(root) !== canonicalRoot) throw new Error('fixture root identity changed; retained for inspection');
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    await mkdir(cwd);
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
    const { initial, sha } = await prepareManagedFixtureHistory(root, cwd, remote);
    const commit = () => { git(cwd, 'add', '-u'); git(cwd, 'commit', '-m', 'candidate'); return git(cwd, 'rev-parse', 'HEAD'); };
    const execution = createManagedExecution(cwd, config, undefined, []);
    return { root, cwd, remote, config, initial, sha, commit, execution,
      ref: (branch: string) => git(root, '--git-dir', remote, 'rev-parse', branch),
      dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'managed fixture preparation and cleanup failed', { cause: cleanup }); }
    throw error;
  }
}
