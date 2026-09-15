import { expect, test } from 'vitest';
import {
  buildSourceTextPackage,
  classifySourcePath,
  decodeSourceText,
  defineSourceSnapshotPolicy,
  reconstructSourceText,
  scanSourceSecrets,
  stageSourceTextFile,
} from '../src/index.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const fileEntry = (path: string) => ({ path, exists: true, type: 'file' as const });

const policy = defineSourceSnapshotPolicy({
  sensitiveBasenames: ['.env', '.npmrc'],
  sensitiveBasenamePrefixes: ['.env.'],
  excludedDirectoryNames: ['node_modules', 'dist'],
  excludedPathPrefixes: ['vendor/', 'static/platform/httpserver-'],
  excludedFileSuffixes: ['.map', '.zip'],
  binaryExtensions: ['.png', '.wasm'],
  textExtensions: ['.ts', '.md', '.json'],
  textBasenames: ['LICENSE'],
  textPathPrefixes: ['.husky/'],
  extensionDecisions: {
    '.svg': { action: 'exclude', ruleId: 'consumer-resource' },
  },
});

test('classifies paths only from consumer-supplied generic policy', () => {
  expect(classifySourcePath(fileEntry('.env.production'), policy)).toEqual({ action: 'exclude', ruleId: 'sensitive-path' });
  expect(classifySourcePath(fileEntry('vendor/runtime.js'), policy)).toEqual({ action: 'exclude', ruleId: 'excluded-path-prefix' });
  expect(classifySourcePath(fileEntry('static/platform/httpserver-linux'), policy)).toEqual({ action: 'exclude', ruleId: 'excluded-path-prefix' });
  expect(classifySourcePath(fileEntry('src/dist/value.ts'), policy)).toEqual({ action: 'exclude', ruleId: 'excluded-directory' });
  expect(classifySourcePath(fileEntry('src/value.js.map'), policy)).toEqual({ action: 'exclude', ruleId: 'excluded-suffix' });
  expect(classifySourcePath(fileEntry('src/logo.PNG'), policy)).toEqual({ action: 'exclude', ruleId: 'binary-extension' });
  expect(classifySourcePath(fileEntry('assets/icon.svg'), policy)).toEqual({ action: 'exclude', ruleId: 'consumer-resource' });
  expect(classifySourcePath(fileEntry('src/main.ts'), policy)).toEqual({ action: 'include', ruleId: 'text' });
  expect(classifySourcePath(fileEntry('.husky/pre-commit'), policy)).toEqual({ action: 'include', ruleId: 'text' });
  expect(classifySourcePath(fileEntry('LICENSE'), policy)).toEqual({ action: 'include', ruleId: 'text' });
  expect(classifySourcePath(fileEntry('data/custom.bin2'), policy)).toEqual({ action: 'review', ruleId: 'unknown-file-type' });
  expect(classifySourcePath({ path: 'src', exists: true, type: 'directory' }, policy)).toEqual({ action: 'exclude', ruleId: 'non-file' });
  expect(classifySourcePath({ path: 'src/missing.ts', exists: false, type: 'missing' }, policy)).toEqual({ action: 'exclude', ruleId: 'missing-entry' });
});

test('policy normalization is immutable and rejects unsafe or contradictory definitions', () => {
  const input = { textExtensions: ['.TS'], binaryExtensions: ['.PNG'] };
  const value = defineSourceSnapshotPolicy(input);
  input.textExtensions.push('.md');
  expect(classifySourcePath(fileEntry('x.ts'), value).action).toBe('include');
  expect(classifySourcePath(fileEntry('x.md'), value).action).toBe('review');
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.textExtensions)).toBe(true);
  expect(() => defineSourceSnapshotPolicy({ textExtensions: ['ts'] })).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY' }));
  expect(() => defineSourceSnapshotPolicy({ textExtensions: ['.x'], binaryExtensions: ['.X'] })).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY' }));
  expect(() => defineSourceSnapshotPolicy({ excludedPathPrefixes: ['../outside/'] })).toThrowError(expect.objectContaining({ code: 'INVALID_POLICY' }));
});

test('decodes UTF-8 and UTF-16 BOM text while rejecting invalid and binary content', () => {
  expect(decodeSourceText(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('hello')]))).toEqual({ text: 'hello', encoding: 'utf8', bom: 'utf8' });
  expect(decodeSourceText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toEqual({ text: 'AB', encoding: 'utf16le', bom: 'utf16le' });
  expect(decodeSourceText(Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]))).toEqual({ text: 'AB', encoding: 'utf16be', bom: 'utf16be' });
  expect(decodeSourceText(new Uint8Array())).toEqual({ text: '', encoding: 'utf8', bom: null });
  expect(() => decodeSourceText(Uint8Array.from([0xc3, 0x28]))).toThrowError(expect.objectContaining({ code: 'INVALID_TEXT_ENCODING' }));
  expect(() => decodeSourceText(Uint8Array.from([0x41, 0x00, 0x42]))).toThrowError(expect.objectContaining({ code: 'BINARY_CONTENT' }));
  expect(() => decodeSourceText(Uint8Array.from([0xff, 0xfe, 0x41]))).toThrowError(expect.objectContaining({ code: 'INVALID_TEXT_ENCODING' }));
});

test('secret scanning reports locations and rules without returning secret values', () => {
  const github = `ghp_${'A1b'.repeat(12)}`;
  const aws = `AKIA${'A1B2'.repeat(4)}`;
  const credential = 'https://person:verySecretValue@example.test/path';
  const bearer = 'Bearer AbCdEf1234567890._-XYZ';
  const findings = scanSourceSecrets([
    { path: 'src/secrets.ts', text: `one\n${github}\n${aws}\n${credential}\n${bearer}\n` },
    { path: 'src/placeholder.ts', text: 'Bearer REPLACE_ME_WITH_TOKEN' },
  ]);
  expect(findings.map(value => value.ruleId)).toEqual(['github-token', 'aws-access-key', 'credential-url', 'bearer-token']);
  expect(findings[0]).toMatchObject({ path: 'src/secrets.ts', line: 2, column: 1, severity: 'block' });
  const serialized = JSON.stringify(findings);
  for (const secret of [github, aws, credential, bearer]) expect(serialized).not.toContain(secret);
});

test('custom secret rules extend defaults without leaking matched values', () => {
  const findings = scanSourceSecrets(
    [{ path: 'config.txt', text: 'CUSTOM_SECRET_123456789' }],
    [{ ruleId: 'consumer-secret', expression: /CUSTOM_SECRET_[0-9]+/gu }],
  );
  expect(findings).toEqual([{ severity: 'block', ruleId: 'consumer-secret', path: 'config.txt', line: 1, column: 1 }]);
  expect(JSON.stringify(findings)).not.toContain('123456789');
});

test('stages bytes with raw integrity while normalizing display newlines', async () => {
  const bytes = utf8('a\r\nb\rc\n');
  const staged = await stageSourceTextFile({ path: 'src/a.ts', group: 'core', bytes });
  expect(staged.text).toBe('a\nb\nc\n');
  expect(staged.byteLength).toBe(bytes.byteLength);
  expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(staged.encoding).toBe('utf8');
  expect(staged.lineCount).toBe(3);
  expect(staged.group).toBe('core');
});

test('packs complete text deterministically including empty files and safe markdown fences', async () => {
  const files = await Promise.all([
    stageSourceTextFile({ path: 'src/fence.md', group: 'docs', bytes: utf8('before\n````\ninside\n````\nafter') }),
    stageSourceTextFile({ path: 'src/empty.ts', group: 'core', bytes: new Uint8Array() }),
    stageSourceTextFile({ path: 'src/value.ts', group: 'core', bytes: utf8('export const value = 1\n') }),
  ]);
  const options = { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20, maxObjectBytesTotal: 100_000 };
  const first = await buildSourceTextPackage(files, options);
  const second = await buildSourceTextPackage([...files].reverse(), options);
  expect(first.objects.map(value => [value.path, value.sha256])).toEqual(second.objects.map(value => [value.path, value.sha256]));
  expect(first.files.map(value => value.path)).toEqual(['src/empty.ts', 'src/fence.md', 'src/value.ts']);
  for (const file of files) expect(reconstructSourceText(first, file.path)).toBe(file.text);
  const fenceObject = first.objects.find(value => value.content.includes('src/fence.md'));
  expect(fenceObject?.content).toContain('`````text');
  expect(first.files.find(value => value.path === 'src/empty.ts')?.segments).toHaveLength(1);
});

test('splits a single oversized Unicode line without text loss or object overflow', async () => {
  const text = `+${'?'.repeat(5000)}`;
  const file = await stageSourceTextFile({ path: 'patches/large.patch', group: 'patches', bytes: utf8(text) });
  const packed = await buildSourceTextPackage([file], { targetObjectBytes: 2048, maxObjectBytes: 4096, maxObjectCount: 100, maxObjectBytesTotal: 500_000 });
  expect(packed.files[0]?.segments.length).toBeGreaterThan(1);
  expect(new Set(packed.files[0]?.segments.map(value => value.startLine))).toEqual(new Set([1]));
  expect(reconstructSourceText(packed, file.path)).toBe(text);
  expect(packed.objects.every(value => value.byteLength <= 4096)).toBe(true);
});

test('packing rejects duplicate paths, unsafe groups and exhausted budgets', async () => {
  const file = await stageSourceTextFile({ path: 'src/a.ts', group: 'core', bytes: utf8('x\n') });
  await expect(buildSourceTextPackage([file, file], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000 })).rejects.toMatchObject({ code: 'DUPLICATE_PATH' });
  await expect(stageSourceTextFile({ path: 'src/a.ts', group: '../private', bytes: utf8('x') })).rejects.toMatchObject({ code: 'INVALID_GROUP' });
  await expect(buildSourceTextPackage([file], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 0, maxObjectBytesTotal: 100_000 })).rejects.toMatchObject({ code: 'PACK_BUDGET_EXCEEDED' });
  await expect(buildSourceTextPackage([file], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 1 })).rejects.toMatchObject({ code: 'PACK_BUDGET_EXCEEDED' });
});

test('reconstruction fails closed when coverage metadata is tampered', async () => {
  const file = await stageSourceTextFile({ path: 'src/a.ts', group: 'core', bytes: utf8('a\nb\n') });
  const packed = await buildSourceTextPackage([file], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000 });
  const firstFile = packed.files[0];
  if (firstFile === undefined) throw new Error('fixture file missing');
  const bad = { ...packed, files: [{ ...firstFile, segments: [] }] };
  expect(() => reconstructSourceText(bad, 'src/a.ts')).toThrowError(expect.objectContaining({ code: 'COVERAGE_INVALID' }));
});


test('creates a publication manifest that binds text coverage and verifies object bytes', async () => {
  const file = await stageSourceTextFile({ path: 'src/a.ts', group: 'core', bytes: utf8('a\nb\n') });
  const packed = await buildSourceTextPackage([file], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000 });
  const { createTextSnapshotManifest } = await import('../src/index.js');
  const manifest = await createTextSnapshotManifest({
    projectId: 'fixture-project',
    policyVersion: '1',
    publishedAt: 1,
    repositories: [{ path: '', head: 'a'.repeat(40), branch: 'dev', dirty: false }],
    textPackage: packed,
  });
  expect(manifest.files[0]?.details).toMatchObject({ group: 'core', encoding: 'utf8', lineCount: 2 });
  expect(manifest.files[0]?.objectPaths).toEqual(packed.objects.map(value => value.path));
  const changedCoverage = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
  const details = changedCoverage.files[0]?.details as { segments?: Array<{ endLine?: number }> } | undefined;
  if (details?.segments?.[0] === undefined) throw new Error('coverage fixture missing');
  details.segments[0].endLine = 99;
  expect(changedCoverage.snapshotId).toBe(manifest.snapshotId);
  const originalObject = packed.objects[0];
  if (originalObject === undefined) throw new Error('object fixture missing');
  const tamperedObject = { ...originalObject, content: `${originalObject.content}tampered` };
  await expect(createTextSnapshotManifest({
    projectId: 'fixture-project', policyVersion: '1', publishedAt: 1,
    repositories: [{ path: '', head: 'a'.repeat(40), branch: 'dev', dirty: false }],
    textPackage: { ...packed, objects: [tamperedObject] },
  })).rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });
});
