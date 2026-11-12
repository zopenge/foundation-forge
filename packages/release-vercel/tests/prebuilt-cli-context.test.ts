import { lstat, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { assertPrebuiltArtifact, freezePrebuiltArtifact } from '../src/node/prebuilt-artifact.js';
import { createPrebuiltCliContext } from '../src/node/prebuilt-cli-context.js';
import { prebuiltFixture } from './helpers/prebuilt-fixture.js';

it('creates missing scratch independently of durable inputs and preserves them after scratch disposal', async () => {
  const f = await prebuiltFixture();
  let cli: Awaited<ReturnType<typeof createPrebuiltCliContext>> | undefined;
  try {
    const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, undefined, async () => {});
    const manifestPath = resolve(artifact.uploadRoot, '.vercel/forge-artifact.json');
    const manifest = await readFile(manifestPath), identity = await lstat(artifact.uploadRoot, { bigint: true });
    await expect(lstat(resolve(f.root, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    cli = await createPrebuiltCliContext(f.root, 'team_fixture');
    const directory = cli.directory;
    expect(dirname(directory)).toBe(resolve(f.root, 'tmp/forge-vercel-release'));
    expect(JSON.parse(await readFile(resolve(directory, 'config.json'), 'utf8'))).toEqual({ currentTeam: 'team_fixture' });
    await cli.dispose(); cli = undefined;
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(resolve(f.root, 'tmp'), { recursive: true });
    expect(await readFile(manifestPath)).toEqual(manifest);
    const retained = await lstat(artifact.uploadRoot, { bigint: true });
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({ dev: identity.dev, ino: identity.ino });
    await expect(assertPrebuiltArtifact(artifact, f.config)).resolves.toBeUndefined();
  } finally { try { await cli?.dispose(); } finally { await f.dispose(); } }
});

it('rejects a linked scratch ancestor before writing private CLI configuration', async () => {
  const f = await prebuiltFixture();
  let cli: Awaited<ReturnType<typeof createPrebuiltCliContext>> | undefined;
  try {
    const foreign = resolve(f.root, 'foreign'); await mkdir(foreign);
    await symlink(foreign, resolve(f.root, 'tmp'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(async () => { cli = await createPrebuiltCliContext(f.root, 'team_fixture'); })
      .rejects.toMatchObject({ code: 'SLOT_PATH', details: { reason: 'LINK_ANCESTOR' } });
    await expect(lstat(resolve(foreign, 'forge-vercel-release'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { try { await cli?.dispose(); } finally { await f.dispose(); } }
});
