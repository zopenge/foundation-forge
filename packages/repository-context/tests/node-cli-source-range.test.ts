import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createRepositoryInvestigator } from '../src/index.js';
import { buildRepositoryCorpus, createFileReader, readRanges } from '../src/node.js';
import { runRepositoryContextCli } from '../src/node/cli.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

const createRecoveryFixture = async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const path = 'src/recipes.ts';
  const lines = Array.from({ length: 310 }, (_, index) => `// filler ${index + 1}: ${'x'.repeat(70)}`);
  lines[0] = "export function buildContext() { return 'stable'; }";
  lines[39] = 'buildContext();';
  lines[139] = '// executeContextQuery first distant occurrence';
  lines[259] = '// executeContextQuery second distant occurrence';
  const text = lines.join('\n');
  await writeFile(join(repository.rootDir, path), text, 'utf8');
  const bytes = await readFile(join(repository.rootDir, path));
  expect(bytes.toString('utf8')).toBe(text);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const built = await buildRepositoryCorpus({ rootDir: repository.rootDir, indexRoot: repository.indexRoot,
    corpusId: 'source-range-fixture', scopes: [path], languages: ['typescript'],
    tsconfigPath: repository.tsconfigPath });
  expect(built.status).toBe('ok');
  const generation = built.generation;
  if (generation === null) throw new Error('fixture generation missing');
  expect(generation.files.find((file) => file.path === path)?.sourceSha256).toBe(sourceSha256);
  return { repository, path, lines, text, sourceSha256, generation };
};

test('公开调查 SDK 的恢复窗口 SourceRef 与实际十行正文保持一致', async () => {
  const fixture = await createRecoveryFixture();
  const reader = createFileReader({ rootDir: fixture.repository.rootDir,
    corpusId: fixture.generation.corpusId, generationId: fixture.generation.generationId });
  const investigator = createRepositoryInvestigator({ corpus: fixture.generation.corpus,
    readRanges: (ranges) => readRanges(reader, ranges), route: 'investigate', preferredScopes: [fixture.path] });
  const result = await investigator.investigate({ query: 'executeContextQuery', scope: [fixture.path],
    evidenceBudget: { maxBytes: 4096 } });
  const recovery = result.sourceHints.filter((hint) => hint.text.includes('executeContextQuery'));
  expect(recovery).toHaveLength(2);
  for (const hint of recovery) {
    expect(hint.text.split('\n')).toHaveLength(10);
    expect(hint.source).toMatchObject({ path: fixture.path, sourceSha256: fixture.sourceSha256,
      lineStart: hint.lineStart, lineEnd: hint.lineEnd });
    expect(hint.text).toBe(fixture.lines.slice(hint.source.lineStart - 1, hint.source.lineEnd).join('\n'));
  }
});

interface EvidencePage {
  readonly evidence: readonly {
    readonly sourceId: string;
    readonly path: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly text: string;
    readonly complete: boolean;
    readonly wholeFile: boolean;
    readonly selectedUnit: string;
    readonly deliveredRange: { readonly lineStart: number; readonly lineEnd: number };
  }[];
  readonly sources: readonly { readonly id: string; readonly path: string; readonly sourceSha256: string }[];
  readonly nextCursor: string | null;
  readonly internallyTruncated: boolean;
}

test('公开 CLI 的首查和续页只为真实源码切片声明完整范围', async () => {
  const fixture = await createRecoveryFixture();
  const args = ['investigate', '--root', fixture.repository.rootDir, '--index', fixture.repository.indexRoot,
    '--query', 'executeContextQuery', '--scope', fixture.path, '--view', 'evidence', '--max-bytes', '4096'];
  const seenCursors = new Set<string>();
  const recoveryRanges: number[][] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    const outputs: string[] = [];
    const exitCode = await runRepositoryContextCli([...args, ...(cursor === null ? [] : ['--cursor', cursor])],
      { write: (value) => outputs.push(value) });
    expect(exitCode).toBe(0);
    expect(outputs).toHaveLength(1);
    expect(Buffer.byteLength(`${outputs[0]}\n`, 'utf8')).toBeLessThanOrEqual(4096);
    const page = JSON.parse(outputs[0] ?? '{}') as EvidencePage;
    expect(page.internallyTruncated).toBe(false);
    for (const part of page.evidence) {
      expect(part.complete).toBe(true);
      expect(part.selectedUnit).toBe('excerpt');
      expect(page.sources.find((source) => source.id === part.sourceId)).toMatchObject({
        path: fixture.path, sourceSha256: fixture.sourceSha256,
      });
      expect(part.deliveredRange).toEqual({ lineStart: part.lineStart, lineEnd: part.lineEnd });
      const delivered = fixture.lines.slice(part.deliveredRange.lineStart - 1, part.deliveredRange.lineEnd).join('\n');
      expect(part.text).toBe(delivered);
      expect(part.wholeFile).toBe(part.text === fixture.text);
      if (part.text.includes('executeContextQuery')) {
        expect(part.text.split('\n')).toHaveLength(10);
        recoveryRanges.push([part.lineStart, part.lineEnd]);
      }
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      expect(seenCursors.has(cursor)).toBe(false);
      seenCursors.add(cursor);
    }
    pageCount += 1;
    expect(pageCount).toBeLessThan(6);
  } while (cursor !== null);
  expect(pageCount).toBeGreaterThan(1);
  expect(recoveryRanges).toEqual([[131, 140], [251, 260]]);
});
