import { mkdir, writeFile } from 'node:fs/promises';
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
  return { exitCode, outputs, parsed: JSON.parse(outputs[0] ?? '{}') as Record<string, unknown> };
};

test('build CLI emits a compact summary while SDK retains the full corpus', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await mkdir(join(repository.rootDir, 'src', 'many'), { recursive: true });
  await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(
    join(repository.rootDir, 'src', 'many', `item-${index}.ts`),
    `export const item${index} = ${index};\n`, 'utf8',
  )));

  const result = await run([
    'build', '--root', repository.rootDir, '--index', repository.indexRoot, '--corpus', 'fixture',    '--scope', 'src', '--language', 'typescript', '--tsconfig', repository.tsconfigPath,
  ]);
  expect(result.exitCode).toBe(0);
  expect(Buffer.byteLength(result.outputs[0] ?? '', 'utf8')).toBeLessThanOrEqual(2048);
  expect(result.parsed).not.toHaveProperty('corpus');
  expect(result.parsed).not.toHaveProperty('generation.corpus');

  const sdkResult = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture-sdk',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  expect(sdkResult.corpus?.entities.length).toBeGreaterThan(80);
});

test.each([
  [['unknown', '--root', 'x', '--index', 'missing'], 'INVALID_ARGUMENT'],
  [['investigate', '--root', 'x', '--index', 'missing'], 'INVALID_ARGUMENT'],
  [['check', '--root', 'x', '--index', 'missing', '--query', 'unused'], 'INVALID_ARGUMENT'],
] as const)('rejects invalid command contracts before index I/O: %j', async (args, expectedCode) => {
  const result = await run(args);
  expect(result.exitCode).toBe(1);
  expect((result.parsed.diagnostics as Array<{ code: string }>)[0]?.code).toBe(expectedCode);
});

test('bounds invalid-argument output without echoing an oversized flag', async () => {
  const hugeFlag = `--${'x'.repeat(8_000)}`;
  const result = await run(['check', hugeFlag, 'value']);
  expect(result.exitCode).toBe(1);
  expect(Buffer.byteLength(result.outputs[0] ?? '', 'utf8')).toBeLessThanOrEqual(2048);
  expect(result.outputs[0]).not.toContain('x'.repeat(512));
});
test('check CLI keeps stale diagnostics within the 2 KiB wire budget', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await mkdir(join(repository.rootDir, 'src', 'changed'), { recursive: true });
  await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(
    join(repository.rootDir, 'src', 'changed', `file-${index}.ts`),
    `export const before${index} = 1;\n`, 'utf8',
  )));
  const built = await run([
    'build', '--root', repository.rootDir, '--index', repository.indexRoot, '--corpus', 'fixture',
    '--scope', 'src', '--language', 'typescript', '--tsconfig', repository.tsconfigPath,
  ]);
  expect(built.exitCode).toBe(0);
  await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(
    join(repository.rootDir, 'src', 'changed', `file-${index}.ts`),
    `export const after${index} = 2;\n`, 'utf8',
  )));
  const checked = await run(['check', '--root', repository.rootDir, '--index', repository.indexRoot]);
  expect(checked.exitCode).toBe(1);
  expect(Buffer.byteLength(`${checked.outputs[0] ?? ''}\n`, 'utf8')).toBeLessThanOrEqual(2048);
  expect(checked.parsed).toMatchObject({ status: 'stale', corpusState: 'stale' });
});

test('首查按实际字节预算选择短文件升级，并保留小预算主要证据', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const primary = (name: string) => [
    `export function ${name}(input: string): string {`,
    ...Array.from({ length: 20 }, (_, index) => `  // ${name} step ${index}`),
    '  return input.trim();',
    '}',
  ].join('\n');
  await writeFile(join(repository.rootDir, 'src', 'alpha.ts'), primary('alphaTarget'), 'utf8');
  await writeFile(join(repository.rootDir, 'src', 'beta.ts'), primary('betaTarget'), 'utf8');
  const related = Array.from({ length: 77 }, (_, index) => {
    if (index === 12) return 'export function contextTarget(input: string): string {';
    if (index === 16) return '  const localValue = input.trim();';
    if (index === 21) return '  return localValue;';
    if (index === 22) return '}';
    return index > 12 && index < 22 ? `  // context step ${index}` : `// supporting line ${index}`;
  }).join('\n');
  await writeFile(join(repository.rootDir, 'src', 'context.ts'), related, 'utf8');
  const built = await buildRepositoryCorpus({ rootDir: repository.rootDir, indexRoot: repository.indexRoot,
    corpusId: 'fixture', scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath });
  expect(built.status).toBe('ok');
  const args = ['investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'alphaTarget betaTarget localValue', '--scope', 'src/', '--view', 'evidence'] as const;
  const large = await run([...args, '--max-bytes', '30000']);
  expect(large.exitCode).toBe(0);
  expect(Buffer.byteLength(`${large.outputs[0]}\n`, 'utf8')).toBeLessThanOrEqual(30_000);
  const largeEvidence = large.parsed.evidence as Array<{ path: string; wholeFile: boolean; text: string }>;
  expect(largeEvidence.find((item) => item.path === 'src/context.ts')).toMatchObject({
    wholeFile: true, text: related,
  });
  const small = await run([...args, '--max-bytes', '4096']);
  expect(small.exitCode).toBe(0);
  expect(Buffer.byteLength(`${small.outputs[0]}\n`, 'utf8')).toBeLessThanOrEqual(4096);
  const smallEvidence = small.parsed.evidence as Array<{ path: string; text: string; complete: boolean }>;
  expect(smallEvidence.find((item) => item.path === 'src/alpha.ts')?.text).toContain('return input.trim();');
  expect(smallEvidence.find((item) => item.path === 'src/beta.ts')?.text).toContain('return input.trim();');
  expect(smallEvidence.filter((item) => item.path === 'src/context.ts' && item.complete).length).toBeLessThanOrEqual(1);
});
