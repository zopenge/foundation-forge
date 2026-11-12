import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as node from '../src/node.js';
import { fixture } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function root(): Promise<string> { const value = await fixture(); cleanups.push(value.cleanup); return value.root; }
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const filesystem = () => process.platform === 'win32'
  ? node.createWindowsNtfsDurableArtifactFilesystem()
  : node.createLinuxDurableArtifactFilesystem();

describe('explicit durable artifact filesystem', () => {
  it('creates a private nested directory chain and publishes complete Unicode bytes', async () => {
    const directory = await root(), io = await filesystem();
    await io.ensureDirectory(directory, 'state/nested');
    await io.publishBytes(directory, 'state/nested/文件.bin', bytes('内容\0\u{1f680}'), { mode: 'exclusive' });
    expect(await fs.readFile(join(directory, 'state/nested/文件.bin'))).toEqual(Buffer.from('内容\0\u{1f680}'));
    expect(await fs.readdir(join(directory, 'state/nested'))).toEqual(['文件.bin']);
    if (process.platform === 'linux') {
      expect((await fs.stat(join(directory, 'state'))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(join(directory, 'state/nested/文件.bin'))).mode & 0o777).toBe(0o600);
    }
  });
  it('refuses an occupied exclusive destination and preserves existing bytes', async () => {
    const directory = await root(), io = await filesystem();
    await io.publishBytes(directory, 'value', bytes('old'), { mode: 'exclusive' });
    await expect(io.publishBytes(directory, 'value', bytes('new'), { mode: 'exclusive' })).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_DESTINATION_OCCUPIED' });
    expect(await fs.readFile(join(directory, 'value'), 'utf8')).toBe('old');
    expect(await fs.readdir(directory)).toEqual(['value']);
  });
  it('atomically replaces an existing destination with complete bytes', async () => {
    const directory = await root(), io = await filesystem();
    await io.publishBytes(directory, 'value', bytes('old'), { mode: 'exclusive' });
    await io.publishBytes(directory, 'value', bytes('new'), { mode: 'replace' });
    expect(await fs.readFile(join(directory, 'value'), 'utf8')).toBe('new');
    expect(await fs.readdir(directory)).toEqual(['value']);
  });
  it('allows exactly one independent exclusive publication to win', async () => {
    const directory = await root(), first = await filesystem(), second = await filesystem();
    const outcomes = await Promise.allSettled([
      first.publishBytes(directory, 'winner', bytes('first'), { mode: 'exclusive' }),
      second.publishBytes(directory, 'winner', bytes('second'), { mode: 'exclusive' }),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes[0]?.status === 'fulfilled' ? 'first' : 'second';
    expect(await fs.readFile(join(directory, 'winner'), 'utf8')).toBe(winner);
    expect(await fs.readdir(directory)).toEqual(['winner']);
  });
  it('snapshots input bytes before asynchronous filesystem work', async () => {
    const directory = await root(), io = await filesystem(), content = bytes('original');
    const publication = io.publishBytes(directory, 'value', content, { mode: 'exclusive' });
    content.fill(0);
    await publication;
    expect(await fs.readFile(join(directory, 'value'), 'utf8')).toBe('original');
  });
  it('rejects path escape and a file used as an ancestor without changing it', async () => {
    const directory = await root(), io = await filesystem();
    await expect(io.ensureDirectory(directory, '../escape')).rejects.toBeInstanceOf(Error);
    await expect(io.publishBytes(directory, '../escape', bytes('x'), { mode: 'replace' })).rejects.toBeInstanceOf(Error);
    await fs.writeFile(join(directory, 'file'), 'keep');
    await expect(io.ensureDirectory(directory, 'file/nested')).rejects.toBeInstanceOf(Error);
    expect(await fs.readFile(join(directory, 'file'), 'utf8')).toBe('keep');
  });
  it('rejects junctions and symlink ancestors without touching outside files', async () => {
    const directory = await root(), outside = await root(), io = await filesystem();
    await fs.symlink(outside, join(directory, 'alias'), 'junction');
    await expect(io.ensureDirectory(directory, 'alias/nested')).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_SYMLINK_REJECTED' });
    await expect(io.publishBytes(directory, 'alias/value', bytes('x'), { mode: 'replace' })).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_SYMLINK_REJECTED' });
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('rejects the provider for a different host before writing', async () => {
    const foreign = process.platform === 'win32' ? node.createLinuxDurableArtifactFilesystem : node.createWindowsNtfsDurableArtifactFilesystem;
    await expect(foreign()).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_DURABILITY_UNSUPPORTED' });
  });
});
