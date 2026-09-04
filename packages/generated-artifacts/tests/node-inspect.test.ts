import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineGeneratedArtifactPlan, type GeneratedArtifactPlan } from '../src/index.js';
import { inspectGeneratedArtifacts } from '../src/node.js';
import { fixture, options } from './fixtures.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function root(): Promise<string> { const value = await fixture(); cleanups.push(value.cleanup); return value.root; }
describe('inspectGeneratedArtifacts', () => {
  it('compares real files and includes explicit retired files', async () => {
    const directory = await root();
    await writeFile(join(directory, 'stale'), 'old'); await writeFile(join(directory, 'retired'), 'old');
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'missing', content: '' }, { path: 'stale', content: 'new' }], retiredPaths: ['retired'] });
    expect(await inspectGeneratedArtifacts(directory, plan, options)).toEqual({ ok: false, missing: ['missing'], stale: ['stale'], retiredPresent: ['retired'] });
  });
  it('rejects relative roots and malformed plans before filesystem access', async () => {
    await expect(inspectGeneratedArtifacts('relative', defineGeneratedArtifactPlan({ artifacts: [] }), options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_ROOT_NOT_ABSOLUTE' });
    const plan: GeneratedArtifactPlan = { artifacts: [{ path: '../escape', content: '' }], retiredPaths: [] };
    await expect(inspectGeneratedArtifacts(join(await root(), 'absent'), plan, options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_INVALID_PATH' });
  });
  it('requires explicit case policy and detects case collisions before I/O', async () => {
    const directory = join(await root(), 'absent');
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'A', content: '' }, { path: 'a', content: '' }] });
    await expect(inspectGeneratedArtifacts(directory, plan, { pathCaseSensitivity: 'case-insensitive' })).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_CASE_COLLISION' });
    expect((await inspectGeneratedArtifacts(directory, plan, options)).missing).toEqual(['A', 'a']);
    await expect(inspectGeneratedArtifacts(directory, plan, JSON.parse('{}') as typeof options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_INVALID_OPTIONS' });
    const overlap = defineGeneratedArtifactPlan({ artifacts: [{ path: 'A', content: '' }], retiredPaths: ['a'] });
    await expect(inspectGeneratedArtifacts(directory, overlap, { pathCaseSensitivity: 'case-insensitive' })).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_CASE_COLLISION' });
  });
  it.each(['target', 'ancestor', 'retired', 'root'] as const)('rejects %s symlinks or junctions', async kind => {
    const directory = await root(); const external = await root();
    await writeFile(join(external, 'file'), 'outside');
    let targetRoot = directory;
    let plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'link/file', content: '' }] });
    if (kind === 'target') {
      await symlink(join(external, 'file'), join(directory, 'link'));
      plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'link', content: '' }] });
    } else if (kind === 'retired') {
      await symlink(external, join(directory, 'link'), 'junction');
      plan = defineGeneratedArtifactPlan({ artifacts: [], retiredPaths: ['link'] });
    } else { await symlink(external, join(directory, 'link'), 'junction'); if (kind === 'root') targetRoot = join(directory, 'link'); }
    await expect(inspectGeneratedArtifacts(targetRoot, plan, options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_SYMLINK_REJECTED' });
  });
  it('rejects directories for expected and retired targets', async () => {
    const directory = await root(); await mkdir(join(directory, 'folder'));
    for (const plan of [defineGeneratedArtifactPlan({ artifacts: [{ path: 'folder', content: '' }] }), defineGeneratedArtifactPlan({ artifacts: [], retiredPaths: ['folder'] })]) await expect(inspectGeneratedArtifacts(directory, plan, options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_TARGET_IS_DIRECTORY' });
  });
});
