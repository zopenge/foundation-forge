import { expect, it, vi } from 'vitest';
import { git, managedFixture } from './helpers/managed-fixture.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Execution } from '../src/node/execution.js';
import { gitRoutingParameters } from './helpers/git-routing.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { prepareCheckout, prepareEnvironment } from '../src/node/managed-checkout.js';
import { ReleaseError } from '../src/node/errors.js';
import { commandComponentSession } from './helpers/component-session.js';

it('preserves process closure failures while reading the frozen manifest', async () => {
  const f = await managedFixture();
  try {
    const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), slot = await openManagedSlot(source, f.execution);
    const session = await createManagedSession(slot, 'check');
    vi.spyOn(session.execution, 'git').mockResolvedValue('f'.repeat(40));
    const failure = new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'FIXTURE_NATIVE_CLOSURE' });
    vi.spyOn(session.execution, 'streamGit').mockRejectedValue(failure);
    await expect(prepareEnvironment(session)).rejects.toBe(failure);
    await slot.lock.release();
  } finally { await f.dispose(); }
});

it('uses a canonical frozen pnpm fixture without changing committed files', async () => {
  const f = await managedFixture();
  try {
    await f.execution.run('install-fixture', { command: 'pnpm', args: ['install', '--frozen-lockfile'] }, 'COMMAND_FAILED',
      { COREPACK_ENABLE_PROJECT_SPEC: '0', npm_config_manage_package_manager_versions: 'false' });
    expect(git(f.cwd, 'status', '--porcelain=v1', '--untracked-files=all'), git(f.cwd, 'diff', '--', 'pnpm-lock.yaml')).toBe('');
  } finally { await f.dispose(); }
});
it('inherits an explicit Git fixture route in real command children', async () => {
  const f = await managedFixture(), declared = 'https://github.com/fixture/repository.git';
  const key = `url.${f.remote.replaceAll('\\', '/')}.insteadOf`;
  try {
    vi.stubEnv('GIT_CONFIG_PARAMETERS', gitRoutingParameters(f.root, f.remote, declared));
    const observed = await f.execution.run('environment', { command: 'node', args: ['-e', 'process.stdout.write(String(process.env.GIT_CONFIG_PARAMETERS?.includes(process.argv[1])))', 'include.path='] }, 'COMMAND_FAILED');
    expect(observed).toBe('true');
    const result = await f.execution.git(['config', '--get', key]).then(value => ({ value }), (error: unknown) => ({ error }));
    expect(result).toMatchObject({ value: declared });
  } finally { vi.unstubAllEnvs(); await f.dispose(); }
});
it('retains the frozen lock bytes after a real Git clone and local object fetch', async () => {
  const f = await managedFixture(); const parent = resolve(f.cwd, '.tmp/release-slot'), checkout = resolve(parent, 'checkout');
  try {
    await mkdir(parent, { recursive: true });
    git(parent, 'clone', '--no-checkout', '--no-local', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', '--origin', 'origin', '--', f.remote, checkout);
    git(checkout, 'fetch', '--no-tags', '--no-recurse-submodules', '--', f.cwd, f.sha);
    git(checkout, 'switch', '--create', 'dev', f.sha);
    const execution = new Execution(checkout, f.config, undefined, []);
    await execution.run('install-fixture', { command: 'pnpm', args: ['install', '--frozen-lockfile'] }, 'COMMAND_FAILED',
      { COREPACK_ENABLE_PROJECT_SPEC: '0', npm_config_manage_package_manager_versions: 'false' });
    const dirty = git(checkout, 'status', '--porcelain=v1', '--untracked-files=all');
    const diagnostic = { dirty, diff: git(checkout, 'diff', '--no-ext-diff', '--no-textconv', '--', 'pnpm-lock.yaml'),
      after: git(checkout, 'status', '--porcelain=v1', '--untracked-files=all'),
      contents: await readFile(resolve(checkout, 'pnpm-lock.yaml'), 'utf8'), committed: git(checkout, 'show', 'HEAD:pnpm-lock.yaml') };
    expect(dirty, JSON.stringify(diagnostic)).toBe('');
  } finally { await f.dispose(); }
});
it.each(['dirty', 'diverged'])('rejects an existing %s checkout without replacing it', async mode => {
  const f = await managedFixture();
  try {
    const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), slot = await openManagedSlot(source, f.execution);
    git(slot.paths.slotRoot, 'clone', '--no-checkout', '--no-local', '--config', 'core.autocrlf=false', '--origin', 'origin', '--', f.remote, slot.paths.checkoutRoot);
    git(slot.paths.checkoutRoot, 'fetch', '--no-tags', '--', f.cwd, source.sha);
    const previous = mode === 'diverged' ? git(slot.paths.checkoutRoot, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit-tree', `${source.sha}^{tree}`, '-p', f.initial, '-m', 'fork') : source.sha;
    git(slot.paths.checkoutRoot, 'switch', '--create', 'dev', previous);
    if (mode === 'dirty') await writeFile(resolve(slot.paths.checkoutRoot, 'source.txt'), 'user modification');
    const session = await createManagedSession(slot, 'check');
    await expect(prepareCheckout(commandComponentSession(session))).rejects.toMatchObject({ code: mode === 'dirty' ? 'GIT_DIRTY' : 'SLOT_NOT_FAST_FORWARD' });
    expect(git(slot.paths.checkoutRoot, 'rev-parse', 'HEAD')).toBe(previous);
    if (mode === 'dirty') expect(await readFile(resolve(slot.paths.checkoutRoot, 'source.txt'), 'utf8')).toBe('user modification');
    expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial); await slot.lock.release();
  } finally { await f.dispose(); }
});
it('initializes a remote whose default branch is the configured development branch', async () => {
  const f = await managedFixture();
  try {
    git(f.root, '--git-dir', f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/dev');
    const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), slot = await openManagedSlot(source, f.execution);
    const session = await createManagedSession(slot, 'check');
    await prepareCheckout(commandComponentSession(session));
    expect(git(slot.paths.checkoutRoot, 'branch', '--show-current')).toBe('dev');
    expect(git(slot.paths.checkoutRoot, 'rev-parse', 'HEAD')).toBe(source.sha);
    expect(git(slot.paths.checkoutRoot, 'status', '--porcelain=v1')).toBe(''); await slot.lock.release();
  } finally { await f.dispose(); }
});

it('creates and fetches a managed checkout beyond the Windows legacy path limit', async () => {
  const f = await managedFixture();
  try {
    if (f.config.source.mode !== 'managed-commit') throw new Error('managed fixture required');
    // 按 fixture 实际根补齐路径，跨过 pack 的 260 字符限制，同时避开 Git 自身 GIT_DIR 的字节限制。
    const paddingBytes = 214 - Buffer.byteLength(resolve(f.cwd, '.tmp/release-slot/checkout/.git')) - 1;
    expect(paddingBytes).toBeGreaterThan(0);
    const config = { ...f.config, source: { ...f.config.source, slotPath: `.tmp/${'p'.repeat(paddingBytes)}/release-slot` } };
    await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(config));
    f.commit();
    const sourceConfig = git(f.cwd, 'config', '--local', '--list');
    const execution = new Execution(f.cwd, config, undefined, []);
    const source = await freezeManagedSource(f.cwd, 'release.config.json', execution), slot = await openManagedSlot(source, execution);
    const session = await createManagedSession(slot, 'check');
    expect(resolve(slot.paths.checkoutRoot, '.git/objects/pack', `pack-${'a'.repeat(40)}.keep`).length).toBeGreaterThan(260);
    await prepareCheckout(commandComponentSession(session)).catch((error: unknown) => { throw new Error(error instanceof ReleaseError ? `${error.code}: ${JSON.stringify(error.details)}` : String(error)); });
    expect(await readFile(resolve(slot.paths.checkoutRoot, 'source.txt'), 'utf8')).toBe('candidate\n');
    expect(git(slot.paths.checkoutRoot, 'rev-parse', 'HEAD')).toBe(source.sha);
    expect(git(f.cwd, 'config', '--local', '--list')).toBe(sourceConfig);
    await slot.lock.release();
  } finally { await f.dispose(); }
});
