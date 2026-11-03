import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { freezePrebuiltArtifact } from '../src/node/prebuilt-artifact.js';
import { vercelInvocation } from '../src/node/execution.js';
import { prebuiltFixture } from './helpers/prebuilt-fixture.js';
import { linkedFunction } from './helpers/prebuilt-linked-output.js';
import { prebuiltCliServer } from './helpers/prebuilt-cli-server.js';
import { cliTarEntries } from './helpers/cli-tar-entries.js';
import { fixtureExec as execute } from './helpers/fixture-exec.js';
import { createPrebuiltCliContext } from '../src/node/prebuilt-cli-context.js';

it.for(['native', 'posix-umask'] as const)('transmits relative links through the fixed official CLI archive without cloud access: %s', async (mode, context) => {
  const f = await prebuiltFixture();
  const inheritedUmask = process.umask();
  const environmentKeys = ['TEMP', 'TMP', 'PATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'];
  const inheritedEnvironment = environmentKeys.map(key => process.env[key]);
  let cliContext: Awaited<ReturnType<typeof createPrebuiltCliContext>> | undefined;
  try {
    const api = await prebuiltCliServer();
    try {
    await linkedFunction(f.output);
    if (process.platform !== 'win32') {
      await chmod(resolve(f.output, 'functions/main.func/index.cjs'), 0o664);
      await chmod(resolve(f.output, 'functions/main.func'), 0o775);
    }
    const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
    cliContext = await createPrebuiltCliContext(artifact.uploadRoot, 'team_fixture', context.signal);
    const privateConfig = cliContext.directory;
    expect(dirname(privateConfig)).toBe(dirname(artifact.uploadRoot));
    if (process.platform !== 'win32') {
      expect((await stat(privateConfig)).mode & 0o777).toBe(0o700);
      expect((await stat(resolve(privateConfig, 'config.json'))).mode & 0o777).toBe(0o600);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'SystemDrive']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, cliContext.environment, { CI: '1', DO_NOT_TRACK: '1', VERCEL_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1', NO_PROXY: '*',
      HOME: privateConfig, USERPROFILE: privateConfig, TEMP: privateConfig, TMP: privateConfig, GIT_CEILING_DIRECTORIES: f.root,
      VERCEL_TOKEN: 'FixtureOnlyNotARealToken0123456789', FORGE_FIXTURE_API_PORT: String(api.port), FORGE_FIXTURE_UMASK: mode === 'posix-umask' ? '022' : '' });
    const invocation = vercelInvocation(['deploy', '--prebuilt', '--archive=tgz', '--prod', '--skip-domain', '--no-wait', '--json', '--non-interactive',
      '--project', 'prj_fixture', '--scope', 'team_fixture', '--global-config', privateConfig, '--api', api.origin], { preserveArchiveModes: true });
    const require = createRequire(import.meta.url), cliPackage = JSON.parse(await readFile(require.resolve('vercel/package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'));
    expect(cliPackage.version).toBe(manifest.dependencies.vercel);
    let stdout: string;
    try {
      ({ stdout } = await execute(invocation.command, ['--import', pathToFileURL(resolve(import.meta.dirname, 'helpers/cli-loopback-only.mjs')).href, ...invocation.args],
        { cwd: artifact.uploadRoot, env, signal: context.signal, timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true, encoding: 'utf8' }));
    } catch (error) { throw new Error(`CLI wire failed; routes=${JSON.stringify(api.requests.map(r => `${r.method} ${r.url}`))}`, { cause: error }); }
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', deployment: { id: 'dpl_fixture', target: 'production' } });
    expect(api.requests.every(request => request.headers.authorization === 'Bearer FixtureOnlyNotARealToken0123456789')).toBe(true);
    for (const path of await readdir(privateConfig, { recursive: true })) {
      const absolute = resolve(privateConfig, path);
      if ((await stat(absolute)).isFile()) expect((await readFile(absolute)).includes(Buffer.from('FixtureOnlyNotARealToken0123456789'))).toBe(false);
    }
    expect(api.requests.filter(r => r.method === 'POST' && r.url.startsWith('/v13/deployments'))).toHaveLength(2);
    const creations = api.requests.filter(r => r.method === 'POST' && r.url.startsWith('/v13/deployments'));
    const body = JSON.parse(creations.at(-1)?.body.toString() ?? '{}');
    const archiveFiles = body.files.filter((file: { file: string }) => file.file.startsWith('.vercel/source.tgz.part'));
    expect(archiveFiles).toHaveLength(1);
    const compressed = api.uploads.get(archiveFiles[0].sha); expect(compressed).toBeDefined();
    if (!compressed) throw new Error('FIXTURE_ARCHIVE_MISSING');
    const entries = cliTarEntries(compressed), links = entries.filter(entry => entry.type === '2');
    expect(entries.some(entry => entry.path.endsWith('auth.json') || entry.bytes.includes(Buffer.from('FixtureOnlyNotARealToken0123456789')))).toBe(false);
    // 官方协议不发送独立目录项；父目录由归档中的文件/链接（含保留 marker）物化。
    expect(entries.filter(entry => entry.type === '5')).toEqual([]);
    expect(entries.some(entry => entry.path === '.vercel/output/static/.well-known/forge-prebuilt.json' && entry.type === '0')).toBe(true);
    expect(links.map(entry => ({ path: entry.path, target: entry.target })).sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual(artifact.links.map(link => ({ path: `.vercel/output/${link.path}`, target: link.target })).sort((a, b) => a.path.localeCompare(b.path)));
    for (const link of artifact.links) expect((links.find(entry => entry.path === `.vercel/output/${link.path}`)?.mode ?? -1) & 0o777).toBe(link.mode);
    for (const directory of artifact.directories) expect((await stat(resolve(artifact.uploadRoot, '.vercel/output', directory.path))).mode & 0o777).toBe(directory.mode);
    for (const file of artifact.files) {
      const entry = entries.find(item => item.path === `.vercel/output/${file.path}`);
      expect(entry?.type).toBe('0'); expect(entry?.bytes.byteLength).toBe(file.byteLength);
      expect(entry && createHash('sha256').update(entry.bytes).digest('hex')).toBe(file.sha256);
      expect(entry && (entry.mode & 0o777)).toBe(file.mode);
    }
    const archive = resolve(f.root, 'received.tgz'), unpacked = resolve(f.root, 'unpacked');
    await writeFile(archive, compressed); await mkdir(unpacked);
    await rm(f.output, { recursive: true }); await rm(artifact.uploadRoot, { recursive: true });
    if (process.platform === 'win32') {
      // 系统 bsdtar 不使用 Windows 的非提权 symlink 标志；只在本测试内用 Node 还原已逐项核对的捕获字节。
      for (const entry of entries) {
        if (entry.type === '5') await mkdir(resolve(unpacked, entry.path), { recursive: true });
        else if (entry.type === '0') {
          await mkdir(dirname(resolve(unpacked, entry.path)), { recursive: true });
          await writeFile(resolve(unpacked, entry.path), entry.bytes);
        }
      }
      for (const entry of links) {
        const original = artifact.links.find(link => `.vercel/output/${link.path}` === entry.path);
        if (!original) throw new Error('FIXTURE_LINK_UNEXPECTED');
        await symlink(entry.target, resolve(unpacked, entry.path), original.kind === 'directory' ? 'dir' : 'file');
      }
    } else await execute('tar', ['-xzf', archive, '-C', unpacked], { signal: context.signal, timeout: 5000, windowsHide: true });
    const loaded = await execute(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]))', resolve(unpacked, '.vercel/output/functions/alias.func/index.cjs')],
      { signal: context.signal, timeout: 5000, windowsHide: true });
    expect(loaded.stdout).toBe('closed-layout');
    } finally { try { await api.dispose(); } finally { await cliContext?.dispose(); } }
  } finally {
    await f.dispose(); expect(process.umask()).toBe(inheritedUmask);
    expect(environmentKeys.map(key => process.env[key])).toEqual(inheritedEnvironment);
  }
});
