import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildRepositoryCorpus } from '../src/node.js';
import { runRepositoryContextCli } from '../src/node/cli.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

const run = async (args: readonly string[]) => {
  const outputs: string[] = [];
  const exitCode = await runRepositoryContextCli(args, { write: (value) => outputs.push(value) });
  return {
    exitCode,
    stdout: outputs[0] ?? '',
    parsed: JSON.parse(outputs[0] ?? '{}') as Record<string, unknown>,
  };
};

const createPagedRepository = async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await writeFile(join(repository.rootDir, 'src', 'hub.ts'), 'export function hub(): string { return "hub"; }\n', 'utf8');
  await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(
    join(repository.rootDir, 'src', `leaf-${index}.ts`),
    `import { hub } from './hub.js';\nexport const leaf${index} = hub();\n`, 'utf8',
  )));
  await writeFile(join(repository.rootDir, 'src', 'long.ts'),
    `export const giant = "${'x'.repeat(128 * 1024)}";\n`, 'utf8');
  await writeFile(join(repository.rootDir, 'src', 'unicode.ts'),
    `export const emojiToken = "${'🙂'.repeat(10_000)}";\n`, 'utf8');
  const built = await buildRepositoryCorpus({
    rootDir: repository.rootDir,
    indexRoot: repository.indexRoot,
    corpusId: 'fixture',
    scopes: ['src'],
    languages: ['typescript'],
    tsconfigPath: repository.tsconfigPath,
  });
  expect(built.status).toBe('ok');
  return repository;
};

test('investigate pages high-indegree relations within the requested byte budget', async () => {
  const repository = await createPagedRepository();
  const base = [
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'hub', '--scope', 'src/', '--view', 'relations', '--max-bytes', '4096',
  ] as const;
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    const page = await run(cursor === null ? base : [...base, '--cursor', cursor]);
    expect(page.exitCode).toBe(0);
    expect(Buffer.byteLength(`${page.stdout}\n`, 'utf8')).toBeLessThanOrEqual(4096);
    const relations = (page.parsed.relations ?? []) as Array<{ from: string; to: string | null; kind: string }>;
    const sources = (page.parsed.sources ?? []) as Array<{ path: string; sourceSha256: string }>;
    expect(new Set(sources.map((source) => source.path)).size).toBe(sources.length);
    expect(sources.every((source) => /^[a-f0-9]{64}$/u.test(source.sourceSha256))).toBe(true);
    for (const relation of relations) seen.add(`${relation.from}|${relation.to ?? ''}|${relation.kind}`);
    cursor = (page.parsed.nextCursor as string | null | undefined) ?? null;
    pageCount += 1;
    expect(pageCount).toBeLessThan(20);
  } while (cursor !== null);
  expect(seen.size).toBe(40);
  expect(pageCount).toBeGreaterThan(1);
});
test('investigate trims an oversized single-line excerpt without claiming completeness', async () => {
  const repository = await createPagedRepository();
  const page = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'giant', '--scope', 'src/', '--view', 'evidence', '--max-bytes', '4096',
  ]);
  expect(page.exitCode).toBe(0);
  expect(Buffer.byteLength(`${page.stdout}\n`, 'utf8')).toBeLessThanOrEqual(4096);
  const evidence = page.parsed.evidence as Array<{ complete: boolean; wholeFile: boolean; text: string; expand?: { path: string } }>;
  expect(evidence[0]?.complete).toBe(false);
  expect(evidence[0]?.wholeFile).toBe(false);
  expect(evidence[0]?.text.length).toBeLessThan(10_000);
  expect(evidence[0]?.expand?.path).toBe('src/long.ts');
  expect((evidence[0] as { deliveredRange?: unknown }).deliveredRange).toBeNull();
  expect(page.parsed.internallyTruncated).not.toBe(false);
  expect(page.parsed.truncated).toBe(true);
  expect(page.parsed.nextCursor).toBeNull();
});

test('UTF-8 多字节巨大单行仍遵守完整 stdout 字节上限', async () => {
  const repository = await createPagedRepository();
  const page = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'emojiToken', '--scope', 'src/unicode.ts', '--view', 'evidence', '--max-bytes', '4096',
  ]);
  expect(page.exitCode).toBe(0);
  expect(Buffer.byteLength(`${page.stdout}\n`, 'utf8')).toBeLessThanOrEqual(4096);
  const evidence = page.parsed.evidence as Array<{ complete: boolean; deliveredRange: unknown; text: string }>;
  expect(evidence[0]?.complete).toBe(false);
  expect(evidence[0]?.deliveredRange).toBeNull();
  expect(page.parsed.internallyTruncated).not.toBe(false);
  expect(evidence[0]?.text).not.toContain('�');
});

test('investigate explicitly identifies a complete small source file', async () => {
  const repository = await createPagedRepository();
  const page = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'hub', '--scope', 'src/hub.ts', '--view', 'evidence', '--max-bytes', '4096',
  ]);
  expect(page.exitCode).toBe(0);
  const evidence = page.parsed.evidence as Array<{
    path: string; lineStart: number; complete: boolean; wholeFile: boolean;
  }>;
  expect(evidence.find((item) => item.path === 'src/hub.ts')).toMatchObject({
    lineStart: 1, complete: true, wholeFile: true,
  });
});

test('continuation cursor is bound to the original investigation request', async () => {
  const repository = await createPagedRepository();
  const first = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'hub', '--scope', 'src/', '--view', 'relations', '--max-bytes', '4096',
  ]);
  const cursor = first.parsed.nextCursor as string;
  expect(cursor).toBeTruthy();
  const mismatch = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'different', '--scope', 'src/', '--view', 'relations', '--max-bytes', '4096', '--cursor', cursor,
  ]);
  expect(mismatch.exitCode).toBe(1);
  expect((mismatch.parsed.diagnostics as Array<{ code: string }>)[0]?.code).toBe('CURSOR_MISMATCH');
});
test('read supports single and batch ranges and rejects an invalid batch atomically', async () => {
  const repository = await createPagedRepository();
  const root = ['--root', repository.rootDir, '--index', repository.indexRoot] as const;
  const single = await run([
    'read', ...root, '--path', 'src/decode.ts', '--line-start', '1', '--line-end', '4', '--max-bytes', '16384',
  ]);
  expect(single.exitCode).toBe(0);
  const singleTexts = single.parsed.texts as Array<{ text: string; complete: boolean }>;
  expect(singleTexts[0]?.text).toContain('decode');
  expect(singleTexts[0]?.complete).toBe(true);

  const ranges = JSON.stringify([
    { path: 'src/decode.ts', lineStart: 1, lineEnd: 2 },
    { path: 'src/session.ts', lineStart: 1, lineEnd: 3 },
  ]);
  const batch = await run(['read', ...root, '--ranges-json', ranges, '--max-bytes', '16384']);
  expect(batch.exitCode).toBe(0);
  expect((batch.parsed.texts as unknown[]).length).toBe(2);

  const invalid = JSON.stringify([
    { path: 'src/decode.ts', lineStart: 1, lineEnd: 2 },
    { path: 'src/session.ts', lineStart: 1, lineEnd: 999 },
  ]);
  const rejected = await run(['read', ...root, '--ranges-json', invalid, '--max-bytes', '16384']);
  expect(rejected.exitCode).toBe(1);
  expect((rejected.parsed.texts as unknown[] | undefined) ?? []).toEqual([]);
  expect((rejected.parsed.diagnostics as Array<{ code: string; details?: Record<string, unknown> }>)[0]).toMatchObject({
    code: 'INVALID_ARGUMENT',
    details: {
      path: 'src/session.ts',
      lineStart: 1,
      lineEnd: 999,
      availableLineEnd: expect.any(Number),
    },
  });
});
test('read refuses stale generations without returning partial texts', async () => {
  const repository = await createPagedRepository();
  await writeFile(join(repository.rootDir, 'src', 'decode.ts'), 'export const changed = true;\n', 'utf8');
  const result = await run([
    'read', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--path', 'src/decode.ts', '--line-start', '1', '--line-end', '1', '--max-bytes', '16384',
  ]);
  expect(result.exitCode).toBe(1);
  expect((result.parsed.diagnostics as Array<{ code: string }>)[0]?.code).toBe('SOURCE_CHANGED');
  expect((result.parsed.texts as unknown[] | undefined) ?? []).toEqual([]);
});

test('read 在完整批量结果未超过字节预算时交付长短文件的全部内容', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const texts = [`export const longNote = '${'x'.repeat(2_000)}';`, 'export const marker = 1;'];
  const paths = ['src/long-note.ts', 'src/marker.ts'];
  await Promise.all(paths.map((path, index) => writeFile(join(repository.rootDir, path), texts[index] ?? '', 'utf8')));
  const built = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  expect(built.status).toBe('ok');
  const result = await run([
    'read', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--ranges-json', JSON.stringify(paths.map((path) => ({ path, lineStart: 1, lineEnd: 1 }))),
    '--max-bytes', '4096',
  ]);
  const rows = result.parsed.texts as Array<{ text: string; complete: boolean }>;
  expect(result.exitCode).toBe(0);
  expect(Buffer.byteLength(`${result.stdout}\n`, 'utf8')).toBeLessThanOrEqual(4096);
  expect(rows.map(({ text }) => text)).toEqual(texts);
  expect(rows.every(({ complete }) => complete)).toBe(true);
  expect(result.parsed.truncated).toBe(false);
  expect(result.parsed.nextCursor).toBeNull();
});

test('rejects an invalid response budget before index I/O', async () => {
  const result = await run([
    'investigate', '--root', 'missing-root', '--index', 'missing-index', '--query', 'hub', '--max-bytes', '100',
  ]);
  expect(result.exitCode).toBe(1);
  expect((result.parsed.diagnostics as Array<{ code: string }>)[0]?.code).toBe('INVALID_ARGUMENT');
});
test('rejects a cursor whose offset was modified without a matching checksum', async () => {
  const repository = await createPagedRepository();
  const first = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'hub', '--scope', 'src/', '--view', 'relations', '--max-bytes', '4096',
  ]);
  const cursor = first.parsed.nextCursor as string;
  const dot = cursor.indexOf('.');
  const prefix = cursor.slice(0, dot);
  const envelope = JSON.parse(Buffer.from(cursor.slice(dot + 1), 'base64url').toString('utf8')) as {
    payload: { offset: number }; checksum: string;
  };
  envelope.payload.offset += 1;
  const tampered = `${prefix}.${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
  const result = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'hub', '--scope', 'src/', '--view', 'relations', '--max-bytes', '4096', '--cursor', tampered,
  ]);
  expect(result.exitCode).toBe(1);
  expect((result.parsed.diagnostics as Array<{ code: string }>)[0]?.code).toBe('CURSOR_MISMATCH');
});
test('rejects a continuation cursor after the current generation changes', async () => {
  const repository = await createPagedRepository();
  const first = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'hub', '--scope', 'src/', '--view', 'relations', '--max-bytes', '4096',
  ]);
  const cursor = first.parsed.nextCursor as string;
  await writeFile(join(repository.rootDir, 'src', 'leaf-0.ts'),
    "import { hub } from './hub.js';\nexport const leaf0Changed = hub();\n", 'utf8');
  const rebuilt = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  expect(rebuilt.status).toBe('ok');
  const result = await run([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'hub', '--scope', 'src/', '--view', 'relations', '--max-bytes', '4096', '--cursor', cursor,
  ]);
  expect(result.exitCode).toBe(1);
  expect((result.parsed.diagnostics as Array<{ code: string }>)[0]?.code).toBe('CURSOR_MISMATCH');
});
