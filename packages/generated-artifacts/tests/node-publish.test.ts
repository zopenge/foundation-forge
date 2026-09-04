import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineGeneratedArtifactPlan } from '../src/index.js';
import { inspectGeneratedArtifacts, publishGeneratedArtifacts } from '../src/node.js';
import { fixture, options } from './fixtures.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function root(): Promise<string> { const value = await fixture(); cleanups.push(value.cleanup); return value.root; }
describe('publishGeneratedArtifacts', () => {
  it('creates parents, writes only changed files and removes only explicit retired files', async () => {
    const directory = await root(); await writeFile(join(directory, 'old'), 'retired'); await writeFile(join(directory, 'unmanaged'), 'keep');
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'nested/a', content: 'first' }, { path: 'b', content: new Uint8Array([0, 255]) }], retiredPaths: ['old', 'absent'] });
    expect(await publishGeneratedArtifacts(directory, plan, options)).toEqual({ written: ['b', 'nested/a'], unchanged: [], removed: ['old'], diagnostics: [] });
    await utimes(join(directory, 'nested/a'), new Date('2001-01-01'), new Date('2001-01-01'));
    const before = (await stat(join(directory, 'nested/a'))).mtimeMs;
    expect(await publishGeneratedArtifacts(directory, plan, options)).toEqual({ written: [], unchanged: ['b', 'nested/a'], removed: [], diagnostics: [] });
    expect((await stat(join(directory, 'nested/a'))).mtimeMs).toBe(before);
    const updated = defineGeneratedArtifactPlan({ artifacts: [{ path: 'nested/a', content: 'changed' }, { path: 'b', content: new Uint8Array([0, 255]) }] });
    expect((await publishGeneratedArtifacts(directory, updated, options)).written).toEqual(['nested/a']);
    expect(await readFile(join(directory, 'nested/a'), 'utf8')).toBe('changed');
    expect(await readFile(join(directory, 'unmanaged'), 'utf8')).toBe('keep');
    expect((await readdir(directory)).sort()).toEqual(['b', 'nested', 'unmanaged']);
  });
  it('uses newline normalization only for comparison and preserves supplied write bytes', async () => {
    const directory = await root();
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: 'a\r\nb\r', comparison: 'normalize-newlines' }] });
    expect((await publishGeneratedArtifacts(directory, plan, options)).written).toEqual(['x']);
    expect(await readFile(join(directory, 'x'), 'utf8')).toBe('a\r\nb\r');
    await writeFile(join(directory, 'x'), 'a\nb\n');
    expect((await publishGeneratedArtifacts(directory, plan, options)).unchanged).toEqual(['x']);
    expect(await readFile(join(directory, 'x'), 'utf8')).toBe('a\nb\n');
  });
  it('preflights every target before writing or deleting', async () => {
    const directory = await root(); await mkdir(join(directory, 'z')); await writeFile(join(directory, 'old'), 'keep');
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'a', content: 'new' }, { path: 'z', content: 'invalid' }], retiredPaths: ['old'] });
    await expect(publishGeneratedArtifacts(directory, plan, options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_TARGET_IS_DIRECTORY' });
    expect((await readdir(directory)).sort()).toEqual(['old', 'z']);
  });
  it('uses unique temporary names for concurrent publications', async () => {
    const directory = await root(); const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: 'same' }] });
    const results = await Promise.all([publishGeneratedArtifacts(directory, plan, options), publishGeneratedArtifacts(directory, plan, options)]);
    expect(results.flatMap(result => result.diagnostics)).toEqual([]);
    expect(await readFile(join(directory, 'x'), 'utf8')).toBe('same'); expect(await readdir(directory)).toEqual(['x']);
  });
});

describe('UTF-8 string publication convergence', () => {
  it('inspects and preserves mtime after writing an unpaired surrogate as UTF-8', async () => {
    const directory = await root();
    const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: '\ud800', comparison: 'normalize-newlines' }] });
    expect((await publishGeneratedArtifacts(directory, plan, options)).written).toEqual(['x']);
    expect([...await readFile(join(directory, 'x'))]).toEqual([239, 191, 189]);
    expect(await inspectGeneratedArtifacts(directory, plan, options)).toEqual({ ok: true, missing: [], stale: [], retiredPresent: [] });
    await utimes(join(directory, 'x'), new Date('2001-01-01'), new Date('2001-01-01'));
    const before = (await stat(join(directory, 'x'))).mtimeMs;
    expect(await publishGeneratedArtifacts(directory, plan, options)).toEqual({ written: [], unchanged: ['x'], removed: [], diagnostics: [] });
    expect((await stat(join(directory, 'x'))).mtimeMs).toBe(before);
  });
});
