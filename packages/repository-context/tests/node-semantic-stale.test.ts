import { mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildRepositoryCorpus, loadCurrentGeneration, verifyGenerationCurrent } from '../src/node.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

const build = async (repository: TemporaryRepository, scopes: readonly string[] = ['src']) => {
  const result = await buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes, languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  });
  expect(result.status).toBe('ok');
  return loadCurrentGeneration(repository.indexRoot);
};

test('marks current stale when compiler configuration changes without source changes', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const generation = await build(repository);
  await writeFile(repository.tsconfigPath, `${JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: false, noEmit: true },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`, 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
});
test('marks current stale when a relevant package manifest changes', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await writeFile(join(repository.rootDir, 'package.json'), '{"name":"fixture","type":"module"}\n', 'utf8');
  const generation = await build(repository);
  await writeFile(join(repository.rootDir, 'package.json'), '{"name":"fixture","type":"commonjs"}\n', 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
});

test('marks current stale when a previously missing module target appears outside the declared source scope', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await writeFile(join(repository.rootDir, 'src', 'main.ts'),
    "import { generated } from '../generated/target.js';\nexport const value = generated;\n", 'utf8');
  const generation = await build(repository, ['src/main.ts']);
  await mkdir(join(repository.rootDir, 'generated'), { recursive: true });
  await writeFile(join(repository.rootDir, 'generated', 'target.ts'), 'export const generated = 1;\n', 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
});
test('tracks the complete tsconfig extends chain', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const basePath = join(repository.rootDir, 'tsconfig.base.json');
  await writeFile(basePath, '{"compilerOptions":{"target":"ES2023","strict":true}}\n', 'utf8');
  await writeFile(repository.tsconfigPath, `${JSON.stringify({
    extends: './tsconfig.base.json',
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`, 'utf8');
  const generation = await build(repository);
  await writeFile(basePath, '{"compilerOptions":{"target":"ES2022","strict":false}}\n', 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
});

test('rejects a legacy generation schema instead of treating it as current', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const generationId = 'legacy-generation';
  await mkdir(join(repository.indexRoot, 'generations'), { recursive: true });
  await writeFile(join(repository.indexRoot, 'current.json'), `${JSON.stringify({ generationId })}\n`, 'utf8');
  await writeFile(join(repository.indexRoot, 'generations', `${generationId}.json`), `${JSON.stringify({
    schemaVersion: 1, corpusId: 'fixture', generationId, inputDigest: 'a'.repeat(64),
    scopes: ['src'], languages: ['typescript'], files: [],
    corpus: { corpusId: 'fixture', generationId, corpusState: 'current-verified', coverage: 'complete-in-declared-scope', entities: [], edges: [] },
  })}\n`, 'utf8');
  await expect(loadCurrentGeneration(repository.indexRoot)).rejects.toMatchObject({ code: 'INDEX_SCHEMA_UPGRADE_REQUIRED' });
});
test('tracks actual TypeScript paths resolution when an alias moves from A to B', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await writeFile(join(repository.rootDir, 'src', 'a.ts'), 'export const aliased = "A";\n', 'utf8');
  await writeFile(join(repository.rootDir, 'src', 'b.ts'), 'export const aliased = "B";\n', 'utf8');
  await writeFile(join(repository.rootDir, 'src', 'main.ts'),
    "import { aliased } from '@value';\nexport const selected = aliased;\n", 'utf8');
  const config = (target: string) => `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', strict: true, noEmit: true,
      baseUrl: '.', paths: { '@value': [target] },
    },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`;
  await writeFile(repository.tsconfigPath, config('src/a.ts'), 'utf8');
  const first = await build(repository);
  expect(first.corpus.edges.some((edge) => edge.from === 'file:src/main.ts' && edge.to === 'file:src/a.ts')).toBe(true);

  await writeFile(repository.tsconfigPath, config('src/b.ts'), 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation: first })).corpusState).toBe('stale');
  const second = await build(repository);
  expect(second.corpus.edges.some((edge) => edge.from === 'file:src/main.ts' && edge.to === 'file:src/b.ts')).toBe(true);
});

test('detects same-length source changes even when mtime is restored', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const generation = await build(repository);
  const path = join(repository.rootDir, 'src', 'decode.ts');
  const before = await stat(path);
  const original = await readFile(path, 'utf8');
  const changed = original.replace('invalid', 'INVALID');
  expect(Buffer.byteLength(changed, 'utf8')).toBe(Buffer.byteLength(original, 'utf8'));
  await writeFile(path, changed, 'utf8');
  await utimes(path, before.atime, before.mtime);
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
});
test('rejects cyclic tsconfig extends before publishing a generation', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const basePath = join(repository.rootDir, 'tsconfig.base.json');
  await writeFile(basePath, '{"extends":"./tsconfig.json"}\n', 'utf8');
  await writeFile(repository.tsconfigPath, '{"extends":"./tsconfig.base.json","compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src/**/*.ts"]}\n', 'utf8');
  await expect(buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
  })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
});

test('rejects a corrupt schema-v2 generation instead of treating it as current', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const generationId = 'corrupt-generation';
  await mkdir(join(repository.indexRoot, 'generations'), { recursive: true });
  await writeFile(join(repository.indexRoot, 'current.json'), `${JSON.stringify({ generationId })}\n`, 'utf8');
  await writeFile(join(repository.indexRoot, 'generations', `${generationId}.json`), `${JSON.stringify({
    schemaVersion: 2, corpusId: 'fixture', generationId, inputDigest: 'a'.repeat(64),
    scopes: ['src'], languages: ['typescript'], files: [], semanticConfigPath: 'tsconfig.json',
    configurationDigest: 'b'.repeat(64), extractorVersion: 'repository-context-v2', sortingVersion: 'v1',
    corpus: { corpusId: 'fixture', generationId, corpusState: 'current-verified', coverage: 'complete-in-declared-scope', entities: [], edges: [] },
  })}\n`, 'utf8');
  await expect(loadCurrentGeneration(repository.indexRoot)).rejects.toMatchObject({ code: 'CORRUPT_INDEX' });
});

test('tracks a workspace-style package link target identity', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const packageA = join(repository.rootDir, 'packages', 'a');
  const packageB = join(repository.rootDir, 'packages', 'b');
  const linkParent = join(repository.rootDir, 'node_modules', '@fixture');
  const linkPath = join(linkParent, 'lib');
  for (const packageRoot of [packageA, packageB]) {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{"name":"@fixture/lib","types":"index.d.ts"}\n', 'utf8');
    await writeFile(join(packageRoot, 'index.d.ts'), 'export declare const linked: number;\n', 'utf8');
  }
  await mkdir(linkParent, { recursive: true });
  await symlink(packageA, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(repository.rootDir, 'src', 'linked.ts'),
    "import { linked } from '@fixture/lib';\nexport const selected = linked;\n", 'utf8');
  const generation = await build(repository);
  expect(generation.semanticInputs.some((item) => item.kind === 'module-target'
    && item.resolvedPath?.replaceAll('\\\\', '/').includes('packages/a/'))).toBe(true);
  await rm(linkPath, { recursive: true, force: true });
  await symlink(packageB, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
});
test('tracks package exports changes and the resolved module target', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const packageRoot = join(repository.rootDir, 'vendor', 'lib');
  const linkParent = join(repository.rootDir, 'node_modules', '@fixture');
  const linkPath = join(linkParent, 'exports-lib');
  await mkdir(packageRoot, { recursive: true });
  await mkdir(linkParent, { recursive: true });
  await writeFile(join(packageRoot, 'a.d.ts'), 'export declare const exported: "A";\n', 'utf8');
  await writeFile(join(packageRoot, 'b.d.ts'), 'export declare const exported: "B";\n', 'utf8');
  const manifest = (target: string) => `${JSON.stringify({
    name: '@fixture/exports-lib', type: 'module', exports: { '.': { types: target, default: target } },
  })}\n`;
  await writeFile(join(packageRoot, 'package.json'), manifest('./a.d.ts'), 'utf8');
  await symlink(packageRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(repository.rootDir, 'src', 'exports.ts'),
    "import { exported } from '@fixture/exports-lib';\nexport const selectedExport = exported;\n", 'utf8');
  const first = await build(repository);
  expect(first.semanticInputs.some((item) => item.kind === 'module-target'
    && item.resolvedPath?.replaceAll('\\\\', '/').endsWith('vendor/lib/a.d.ts'))).toBe(true);

  await writeFile(join(packageRoot, 'package.json'), manifest('./b.d.ts'), 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation: first })).corpusState).toBe('stale');
  const second = await build(repository);
  expect(second.semanticInputs.some((item) => item.kind === 'module-target'
    && item.resolvedPath?.replaceAll('\\\\', '/').endsWith('vendor/lib/b.d.ts'))).toBe(true);
});

test('tracks referenced project configuration as a semantic input', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const referencedRoot = join(repository.rootDir, 'referenced');
  await mkdir(referencedRoot, { recursive: true });
  const referencedConfig = join(referencedRoot, 'tsconfig.json');
  await writeFile(referencedConfig, '{"compilerOptions":{"composite":true,"target":"ES2023"},"files":[]}\n', 'utf8');
  await writeFile(repository.tsconfigPath, `${JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', strict: true, noEmit: true },
    include: ['src/**/*.ts'], references: [{ path: './referenced' }],
  }, null, 2)}\n`, 'utf8');
  const generation = await build(repository);
  expect(generation.semanticInputs.some((item) => item.kind === 'tsconfig' && item.path === 'referenced/tsconfig.json')).toBe(true);
  await writeFile(referencedConfig, '{"compilerOptions":{"composite":true,"target":"ES2022"},"files":[]}\n', 'utf8');
  expect((await verifyGenerationCurrent({ rootDir: repository.rootDir, generation })).corpusState).toBe('stale');
});
test('rejects a package link whose real target escapes the repository root', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const externalRoot = join(repository.rootDir, '..', `external-${Date.now()}`);
  const linkParent = join(repository.rootDir, 'node_modules', '@fixture');
  const linkPath = join(linkParent, 'outside-lib');
  try {
    await mkdir(externalRoot, { recursive: true });
    await writeFile(join(externalRoot, 'package.json'), '{"name":"@fixture/outside-lib","types":"index.d.ts"}\n', 'utf8');
    await writeFile(join(externalRoot, 'index.d.ts'), 'export declare const outside: number;\n', 'utf8');
    await mkdir(linkParent, { recursive: true });
    await symlink(externalRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(repository.rootDir, 'src', 'outside.ts'),
      "import { outside } from '@fixture/outside-lib';\nexport const selectedOutside = outside;\n", 'utf8');
    await expect(buildRepositoryCorpus({
      rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
      scopes: ['src'], languages: ['typescript'], tsconfigPath: repository.tsconfigPath,
    })).rejects.toMatchObject({ code: 'SEMANTIC_INPUT_OUTSIDE_ROOT' });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});
