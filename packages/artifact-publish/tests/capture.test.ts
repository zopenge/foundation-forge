import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/node.js';

interface Snapshot {
  readonly content: { readonly manifestSha256: string };
  readonly manifest: { readonly files: readonly { readonly path: string; readonly sha256: string }[] };
  readonly manifestBytes: Uint8Array;
  readonly payloadByteLength: number;
  readFile(path: string): Uint8Array;
}
const call = (name: string, input: unknown): Promise<Snapshot> => {
  const operation: unknown = Reflect.get(api, name);
  expect(operation).toBeTypeOf('function');
  if (typeof operation !== 'function') throw new Error('missing public operation');
  return operation(input) as Promise<Snapshot>;
};
const capture = (input: unknown) => call('captureArtifactFiles', input);
const verify = (input: unknown) => call('verifyArtifactFiles', input);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const raw = Uint8Array.from([0, 255, 239, 187, 191, 13, 10, 128]);
const first = <T>(values: readonly T[]): T => {
  const value = values[0]; if (value === undefined) throw new Error('missing fixture'); return value;
};
let directory: string;
let source: string;
const options = () => ({
  sources: [{ rootDirectory: source, closure: 'exact', files: [{ sourcePath: 'in.bin', path: 'server/app.bin', role: 'control' }] }],
  pathCaseSensitivity: 'case-sensitive', maxFiles: 10, maxEntries: 100,
  maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 2048, timeoutMilliseconds: 5000,
});

beforeEach(async () => {
  await mkdir(resolve(repositoryRoot, 'tmp'), { recursive: true });
  directory = await mkdtemp(resolve(repositoryRoot, 'tmp', 'cap-'));
  source = resolve(directory, 's');
  await mkdir(source);
  await writeFile(resolve(source, 'in.bin'), raw);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe('independent raw artifact capture', () => {
  it('captures raw bytes from separate roots into one canonical logical manifest without staging', async () => {
    const ui = resolve(directory, 'ui'); await mkdir(ui); await writeFile(resolve(ui, 'index.html'), 'ui');
    const input = options();
    input.sources.push({ rootDirectory: ui, closure: 'exact', files: [{ sourcePath: 'index.html', path: 'ui/index.html', role: 'control' }] });
    const result = await capture(input);
    expect(result.readFile('server/app.bin')).toEqual(raw);
    expect(result.readFile('ui/index.html')).toEqual(new TextEncoder().encode('ui'));
    expect(result.payloadByteLength).toBe(10);
    const expected = JSON.stringify({ schemaVersion: 1, files: [
      { path: 'server/app.bin', role: 'control', byteLength: 8, sha256: createHash('sha256').update(raw).digest('hex') },
      { path: 'ui/index.html', role: 'control', byteLength: 2, sha256: createHash('sha256').update('ui').digest('hex') },
    ] });
    // 独立预期使用 Node hash 核对负载及最终清单，不调用被测清单构造器。
    const canonical = expected;
    expect(new TextDecoder().decode(result.manifestBytes)).toBe(canonical);
    expect(result.content.manifestSha256).toBe(createHash('sha256').update(canonical).digest('hex'));
    input.sources.reverse();
    expect((await capture(input)).content).toEqual(result.content);
  });

  it('keeps private bytes immutable after source and returned byte arrays are modified', async () => {
    const result = await capture(options());
    const content = result.content.manifestSha256;
    result.readFile('server/app.bin').fill(1); result.manifestBytes.fill(0);
    await writeFile(resolve(source, 'in.bin'), 'replacement');
    expect(result.readFile('server/app.bin')).toEqual(raw);
    expect(createHash('sha256').update(result.manifestBytes).digest('hex')).toBe(content);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.manifest.files)).toBe(true);
    expect(() => result.readFile('absent')).toThrow(expect.objectContaining({ code: 'INVALID_SOURCE' }));
  });

  it('verifies canonical bytes, expected content and same-length real payload changes', async () => {
    const first = await capture(options());
    const input = { ...options(), manifestBytes: first.manifestBytes, expectedContent: first.content };
    expect((await verify(input)).content).toEqual(first.content);
    await writeFile(resolve(source, 'in.bin'), new Uint8Array(raw.length));
    await expect(verify(input)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });

  it('rejects noncanonical manifests even when their digest matches the supplied bytes', async () => {
    const first = await capture(options());
    const manifestBytes = new TextEncoder().encode(new TextDecoder().decode(first.manifestBytes) + '\n');
    await expect(verify({ ...options(), manifestBytes, expectedContent: { manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') } }))
      .rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });

  it.each(['extra-file', 'empty-directory'])('enforces exact closure for %s while declared mode reads only selected files', async kind => {
    if (kind === 'extra-file') await writeFile(resolve(source, 'other'), 'other');
    else await mkdir(resolve(source, 'empty'));
    await expect(capture(options())).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    const input = options(); first(input.sources).closure = 'declared';
    expect((await capture(input)).readFile('server/app.bin')).toEqual(raw);
  });

  it.each(['case-file', 'case-parent', 'file-parent'])('rejects %s aliases after logical mapping', async kind => {
    const input = options(); input.pathCaseSensitivity = 'case-insensitive';
    const path = kind === 'case-file' ? 'SERVER/APP.BIN' : kind === 'case-parent' ? 'SERVER/other' : 'server';
    first(input.sources).files.push({ sourcePath: 'second', path, role: 'control' });
    await writeFile(resolve(source, 'second'), '2');
    await expect(capture(input)).rejects.toMatchObject({ code: 'INVALID_PLAN' });
  });

  it('distinguishes physically separate case names from filesystem aliases in declared mode', async () => {
    await writeFile(resolve(source, 'IN.BIN'), raw);
    const input = options(); first(input.sources).closure = 'declared';
    first(input.sources).files.push({ sourcePath: 'IN.BIN', path: 'second', role: 'control' });
    const distinct = await realpath(resolve(source, 'IN.BIN')) !== await realpath(resolve(source, 'in.bin'));
    if (distinct) expect((await capture(input)).manifest.files).toHaveLength(2);
    else await expect(capture(input)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it.each(['../out', '/absolute', 'a\\b'])('rejects unsafe source mapping %s', async sourcePath => {
    const input = options(); first(first(input.sources).files).sourcePath = sourcePath;
    await expect(capture(input)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('rejects symbolic-link ancestors and directories as files', async () => {
    const alias = resolve(directory, 'alias');
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const input = options(); first(input.sources).rootDirectory = alias;
    await expect(capture(input)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    first(input.sources).rootDirectory = directory; first(input.sources).closure = 'declared'; first(first(input.sources).files).sourcePath = 's';
    await expect(capture(input)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it.each(['maxFiles', 'maxEntries', 'maxFileBytes', 'maxTotalBytes', 'maxManifestBytes', 'timeoutMilliseconds'])('requires a finite positive %s', async key => {
    await expect(capture({ ...options(), [key]: Infinity })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it.each(['maxFileBytes', 'maxTotalBytes', 'maxManifestBytes', 'maxEntries'])('enforces the %s budget', async key => {
    await expect(capture({ ...options(), [key]: 1 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('counts the manifest in the total byte budget', async () => {
    const first = await capture(options());
    await expect(capture({ ...options(), maxTotalBytes: first.payloadByteLength + first.manifestBytes.length - 1 }))
      .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('honors cancellation and an elapsed deadline without changing host settings', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(capture({ ...options(), signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10);
    await expect(capture({ ...options(), timeoutMilliseconds: 1 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('includes mapping preparation in the original deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const input = options();
    Object.defineProperty(first(first(input.sources).files), 'sourcePath', { get() { now = 100000; return 'in.bin'; } });
    await expect(capture({ ...input, timeoutMilliseconds: 1000 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
});
