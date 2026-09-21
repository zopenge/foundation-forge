import { afterEach, expect, test } from 'vitest';
import { isRepositoryContextCliEntry, runRepositoryContextCli } from '../src/node/cli.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

test('build and investigate commands emit one structured JSON envelope each', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const outputs: string[] = [];
  const write = (value: string): void => { outputs.push(value); };

  expect(await runRepositoryContextCli([
    'build', '--root', repository.rootDir, '--index', repository.indexRoot, '--corpus', 'fixture',
    '--scope', 'src', '--language', 'typescript', '--tsconfig', repository.tsconfigPath,
  ], { write })).toBe(0);
  expect(outputs).toHaveLength(1);
  expect(JSON.parse(outputs.pop() ?? '{}')).toMatchObject({ status: 'ok' });

  expect(await runRepositoryContextCli([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'decode invalid', '--scope', 'src/',
  ], { write })).toBe(0);
  expect(outputs).toHaveLength(1);
  expect(JSON.parse(outputs[0] ?? '{}')).toMatchObject({ status: 'ok' });
});

test('unknown flags return INVALID_ARGUMENT without throwing', async () => {
  const outputs: string[] = [];
  expect(await runRepositoryContextCli(['check', '--wat'], { write: (value) => outputs.push(value) })).toBe(1);
  expect(JSON.parse(outputs[0] ?? '{}').diagnostics[0].code).toBe('INVALID_ARGUMENT');
});

test('CLI entry detection resolves package-manager symlinks before comparing paths', () => {
  const canonical = 'C:\\store\\repository-context\\dist\\node\\cli.js';
  const realpath = (value: string): string => value.includes('node_modules') ? canonical : value;

  expect(isRepositoryContextCliEntry(
    'C:\\repo\\node_modules\\@openge\\forge-repository-context\\dist\\node\\cli.js',
    'file:///C:/store/repository-context/dist/node/cli.js',
    realpath,
  )).toBe(true);
});
