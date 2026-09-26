import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile,
} from '@openge/forge-source-snapshot';
import { publishSourceSnapshot } from '@openge/forge-source-snapshot/node';
import {
  buildRepositoryCorpus, readRanges, verifyGenerationCurrent, verifyGenerationFrozen,
} from '../src/node.js';
import { runRepositoryContextCli } from '../src/node/cli.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
const externalRoots: string[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.cleanup()));
  await Promise.all(externalRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const prepareRepository = async (): Promise<TemporaryRepository> => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await Promise.all([
    writeFile(join(repository.rootDir, 'package.json'), '{"type":"module"}\n', 'utf8'),
    writeFile(join(repository.rootDir, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8'),
    writeFile(join(repository.rootDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8'),
  ]);
  return repository;
};
const publishGenerationSnapshot = async (repository: TemporaryRepository, generation: NonNullable<Awaited<ReturnType<typeof buildRepositoryCorpus>>['generation']>, existingTargetRoot?: string) => {
  const targetRoot = existingTargetRoot ?? await mkdtemp(join(dirname(repository.rootDir), 'repo-context-frozen-'));
  if (existingTargetRoot === undefined) externalRoots.push(targetRoot);
  const requiredPaths = [...new Set([
    ...generation.files.map((file) => file.path),
    ...generation.semanticInputs.filter((input) => input.state === 'present').map((input) => input.path),
  ])].sort();
  const staged = await Promise.all(requiredPaths.map(async (path) => stageSourceTextFile({
    path, group: 'repository-context', bytes: await readFile(join(repository.rootDir, ...path.split('/'))),
  })));
  const textPackage = await buildSourceTextPackage(staged, {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 100,
    maxObjectBytesTotal: 2_000_000, textFormatVersion: 2,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'repository-context-frozen-test', policyVersion: '1', publishedAt: 1, repositories: [], textPackage,
  });
  await publishSourceSnapshot({ manifest, textPackage }, {
    sourceRoot: repository.rootDir, targetRoot, lockPath: `${targetRoot}.lock`,
    ownerId: 'repository-context-test',
  });
  return { targetRoot, snapshotId: manifest.snapshotId };
};
test('accepts only an authorized immutable snapshot and keeps it independent from mutable source drift', async () => {
  const repository = await prepareRepository();
  const built = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  expect(built.status).toBe('ok');
  const generation = built.generation;
  if (!generation) throw new Error('missing generation');
  expect(generation.semanticInputs.filter((input) => input.state === 'missing')).toEqual([]);
  const frozen = await publishGenerationSnapshot(repository, generation);

  const verification = await verifyGenerationFrozen({
    generation, source: { targetRoot: frozen.targetRoot, ownerId: 'repository-context-test', snapshotId: frozen.snapshotId },
  });
  expect(verification).toMatchObject({ status: 'ok', corpusState: 'frozen', snapshotId: frozen.snapshotId });

  await writeFile(join(repository.rootDir, 'src', 'session.ts'), 'export const changed = true;\n', 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
  expect((await verifyGenerationFrozen({
    generation, source: { targetRoot: frozen.targetRoot, ownerId: 'repository-context-test', snapshotId: frozen.snapshotId },
  })).corpusState).toBe('frozen');
});
test('reads verified ranges from the frozen snapshot and rejects a mutable directory masquerading as a store', async () => {
  const repository = await prepareRepository();
  const built = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  const generation = built.generation;
  if (!generation) throw new Error('missing generation');
  const frozen = await publishGenerationSnapshot(repository, generation);
  const source = generation.corpus.entities.find((entity) => entity.source.path === 'src/session.ts')?.source;
  if (!source) throw new Error('missing source');
  const verified = await verifyGenerationFrozen({
    generation, source: { targetRoot: frozen.targetRoot, ownerId: 'repository-context-test', snapshotId: frozen.snapshotId },
  });
  if (verified.status !== 'ok' || verified.reader === null) throw new Error('frozen verification failed');
  const read = await readRanges(verified.reader, [{ ...source, lineStart: 1, lineEnd: 2 }]);
  expect(read.texts[0]?.text).toContain('decode');

  const rejected = await verifyGenerationFrozen({
    generation, source: { targetRoot: repository.rootDir, ownerId: 'repository-context-test', snapshotId: frozen.snapshotId },
  });
  expect(rejected.status).toBe('error');
  expect(rejected.corpusState).toBe('unknown');
  expect(rejected.diagnostics[0]?.code).toBe('FROZEN_SOURCE_UNVERIFIED');
});
test('keeps an explicitly bound frozen snapshot valid when the store current entry switches', async () => {
  const repository = await prepareRepository();
  const built = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  const generation = built.generation;
  if (!generation) throw new Error('missing generation');
  const first = await publishGenerationSnapshot(repository, generation);
  await writeFile(join(repository.rootDir, 'src', 'session.ts'), 'export const switched = true;\n', 'utf8');
  const second = await publishGenerationSnapshot(repository, generation, first.targetRoot);
  expect(second.snapshotId).not.toBe(first.snapshotId);

  const oldVerification = await verifyGenerationFrozen({
    generation, source: { targetRoot: first.targetRoot, ownerId: 'repository-context-test', snapshotId: first.snapshotId },
  });
  expect(oldVerification).toMatchObject({ status: 'ok', corpusState: 'frozen', snapshotId: first.snapshotId });
  if (oldVerification.status !== 'ok') throw new Error('old snapshot verification failed');
  const source = generation.corpus.entities.find((entity) => entity.source.path === 'src/session.ts')?.source;
  if (!source) throw new Error('missing source');
  const read = await readRanges(oldVerification.reader, [{ ...source, lineStart: 1, lineEnd: 1 }]);
  expect(read.texts[0]?.text).toContain('import { decode }');
});
test('CLI reports frozen state from explicit snapshot credentials and query paths stay read-only', async () => {
  const repository = await prepareRepository();
  const built = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  const generation = built.generation;
  if (!generation) throw new Error('missing generation');
  const frozen = await publishGenerationSnapshot(repository, generation);
  await writeFile(join(repository.rootDir, 'src', 'session.ts'), 'export const mutable = true;\n', 'utf8');
  const indexBefore = (await readdir(repository.indexRoot, { recursive: true })).sort();
  const storeBefore = (await readdir(frozen.targetRoot, { recursive: true })).sort();
  const base = ['--root', repository.rootDir, '--index', repository.indexRoot,
    '--snapshot-root', frozen.targetRoot, '--snapshot-owner', 'repository-context-test', '--snapshot-id', frozen.snapshotId];
  const checkOut: string[] = [];
  expect(await runRepositoryContextCli(['check', ...base], { write: (value) => checkOut.push(value) })).toBe(0);
  expect(JSON.parse(checkOut[0] ?? '{}')).toMatchObject({ status: 'ok', corpusState: 'frozen' });
  const investigateOut: string[] = [];
  expect(await runRepositoryContextCli(['investigate', ...base, '--query', 'createSession', '--scope', 'src/'],
    { write: (value) => investigateOut.push(value) })).toBe(0);
  expect(JSON.parse(investigateOut[0] ?? '{}')).toMatchObject({ corpusState: 'frozen' });
  expect((await readdir(repository.indexRoot, { recursive: true })).sort()).toEqual(indexBefore);
  expect((await readdir(frozen.targetRoot, { recursive: true })).sort()).toEqual(storeBefore);
});
test('does not enable frozen when semantic input absence cannot be proven by the snapshot manifest', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const built = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  const generation = built.generation;
  if (!generation) throw new Error('missing generation');
  expect(generation.semanticInputs.some((input) => input.state === 'missing')).toBe(true);
  const verification = await verifyGenerationFrozen({
    generation, source: { targetRoot: repository.rootDir, ownerId: 'untrusted', snapshotId: `snapshot-${'a'.repeat(64)}` },
  });
  expect(verification).toMatchObject({ status: 'error', corpusState: 'unknown', snapshotId: null });
  expect(verification.diagnostics[0]).toMatchObject({
    code: 'FROZEN_SOURCE_UNVERIFIED', details: { reason: 'missing-input-proof-unavailable' },
  });
});
