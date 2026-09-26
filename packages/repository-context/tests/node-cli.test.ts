import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

test('investigate keeps --scope hard and reports terminal missing scope without parent fallback', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const outputs: string[] = [];
  const write = (value: string): void => { outputs.push(value); };

  expect(await runRepositoryContextCli([
    'build', '--root', repository.rootDir, '--index', repository.indexRoot, '--corpus', 'fixture',
    '--scope', 'src', '--language', 'typescript', '--tsconfig', repository.tsconfigPath,
  ], { write })).toBe(0);
  outputs.length = 0;

  expect(await runRepositoryContextCli([
    'investigate', '--root', repository.rootDir, '--index', repository.indexRoot,
    '--query', 'worker pool export', '--scope', 'src/missing-worker-pool', '--view', 'evidence',
  ], { write })).toBe(1);

  expect(outputs).toHaveLength(1);
  expect(JSON.parse(outputs[0] ?? '{}')).toMatchObject({
    status: 'insufficient',
    reason: 'REQUESTED_SCOPE_MISSING',
    candidates: [],
    evidence: [],
    primaryScopeCoverage: {
      covered: [],
      missing: ['src/missing-worker-pool'],
    },
    diagnostics: [{
      code: 'REQUESTED_SCOPE_MISSING',
      details: { scopes: ['src/missing-worker-pool'] },
    }],
  });
});

test('unknown flags return INVALID_ARGUMENT without throwing', async () => {
  const outputs: string[] = [];
  expect(await runRepositoryContextCli(['check', '--wat'], { write: (value) => outputs.push(value) })).toBe(1);
  expect(JSON.parse(outputs[0] ?? '{}').diagnostics[0].code).toBe('INVALID_ARGUMENT');
});

test('CLI entry detection resolves package-manager symlinks before comparing paths', () => {
  const linked = resolve('node_modules/@openge/forge-repository-context/dist/node/cli.js');
  const canonical = resolve('store/repository-context/dist/node/cli.js');
  const realpath = (value: string): string => value === linked ? canonical : value;

  expect(isRepositoryContextCliEntry(
    linked,
    pathToFileURL(canonical).href,
    realpath,
  )).toBe(true);
});

test('CLI entry detection fails closed for missing or unreadable paths', () => {
  const unreadable = (): string => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

  expect(isRepositoryContextCliEntry(undefined, import.meta.url)).toBe(false);
  expect(isRepositoryContextCliEntry('missing-cli.js', import.meta.url, unreadable)).toBe(false);
});
