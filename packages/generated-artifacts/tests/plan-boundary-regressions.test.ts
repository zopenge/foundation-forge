import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type GeneratedArtifactPlan } from '../src/index.js';
import { inspectGeneratedArtifacts, publishGeneratedArtifacts } from '../src/node.js';
import { fixture, options } from './fixtures.js';

vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function root(): Promise<string> { const value = await fixture(); cleanups.push(value.cleanup); return value.root; }

describe('pre-I/O path contract regressions', () => {
  it.each([
    { artifacts: [{ path: '\ud800', content: 'first' }, { path: '\ud801', content: 'second' }], retiredPaths: [] },
    { artifacts: [{ path: '\ud800', content: 'first' }], retiredPaths: ['\ud801'] },
  ])('rejects UTF-8 filesystem aliases before I/O', async (plan: GeneratedArtifactPlan) => {
    const directory = await root();
    const metadataRead = vi.spyOn(filesystem, 'lstat');
    await expect(publishGeneratedArtifacts(directory, plan, options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_INVALID_PATH' });
    expect(metadataRead).not.toHaveBeenCalled();
    expect(await filesystem.readdir(directory)).toEqual([]);
  });

  it('publishes a valid paired-surrogate path without loss', async () => {
    const directory = await root();
    const plan: GeneratedArtifactPlan = { artifacts: [{ path: '\ud83d\ude80.txt', content: 'paired' }], retiredPaths: [] };
    expect(await publishGeneratedArtifacts(directory, plan, options)).toEqual({ written: ['\ud83d\ude80.txt'], unchanged: [], removed: [], diagnostics: [] });
    expect(await filesystem.readFile(join(directory, '\ud83d\ude80.txt'), 'utf8')).toBe('paired');
  });
});

describe('file and ancestor plan collisions', () => {
  it.each([
    { artifacts: [{ path: 'a', content: '' }, { path: 'a/b', content: '' }], retiredPaths: [], pathCaseSensitivity: 'case-sensitive' },
    { artifacts: [{ path: 'a', content: '' }], retiredPaths: ['a/b'], pathCaseSensitivity: 'case-sensitive' },
    { artifacts: [{ path: 'a/b', content: '' }], retiredPaths: ['a'], pathCaseSensitivity: 'case-sensitive' },
    { artifacts: [], retiredPaths: ['a', 'a/b'], pathCaseSensitivity: 'case-sensitive' },
    { artifacts: [{ path: 'A', content: '' }, { path: 'a/b', content: '' }], retiredPaths: [], pathCaseSensitivity: 'case-insensitive' },
    { artifacts: [{ path: 'a/b', content: '' }], retiredPaths: ['A'], pathCaseSensitivity: 'case-insensitive' },
  ] as const)('rejects impossible file/ancestor plans before any I/O: %j', async input => {
    const directory = await root();
    const plan: GeneratedArtifactPlan = { artifacts: input.artifacts, retiredPaths: input.retiredPaths };
    const operationOptions = { pathCaseSensitivity: input.pathCaseSensitivity };
    const metadataRead = vi.spyOn(filesystem, 'lstat');
    await expect(publishGeneratedArtifacts(directory, plan, operationOptions)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_PATH_CONFLICT' });
    await expect(inspectGeneratedArtifacts(directory, plan, operationOptions)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_PATH_CONFLICT' });
    expect(metadataRead).not.toHaveBeenCalled();
    expect(await filesystem.readdir(directory)).toEqual([]);
  });

  it('honors case-sensitive policy and matches full path segments', async () => {
    const directory = await root();
    const plan: GeneratedArtifactPlan = { artifacts: [{ path: 'A', content: '' }, { path: 'a/b', content: '' }, { path: 'ab', content: '' }], retiredPaths: [] };
    expect((await inspectGeneratedArtifacts(directory, plan, options)).missing).toEqual(['A', 'a/b', 'ab']);
  });
});
