import { expect, test } from 'vitest';
import { createRepositoryInvestigator } from '../src/index.js';
import type { Corpus, SourceRef } from '../src/core/contracts.js';
import { corpusFixture, sourceRef } from './repository-fixtures.js';

const reader = async (ranges: readonly SourceRef[]) => ({
  schemaVersion: 1 as const,
  status: 'ok' as const,
  corpusId: 'fixture',
  generationId: 'g1',
  diagnostics: [],
  texts: ranges.map((source) => ({
    source,
    path: source.path,
    lineStart: source.lineStart,
    lineEnd: source.lineEnd,
    text: `export function ${source.path.includes('decode') ? 'decodeSession' : 'createSession'}() { return true; }`,
  })),
});

test('promotes resolved relation endpoint paths without duplicating candidates', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: reader,
    route: 'investigate-relations',
    preferredScopes: ['src/'],
    promoteRelationEndpoints: true,
  });
  const result = await investigator.investigate({ query: 'createSession' });
  expect(result.relations.some((edge) => edge.toPath === 'src/decode.ts')).toBe(true);
  expect(new Set(result.candidates.map((item) => item.id)).size).toBe(result.candidates.length);
});

test('rejects a blank query with a structured result', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture() as Corpus,
    readRanges: reader,
    route: 'investigate',
  });
  const result = await investigator.investigate({ query: '   ' });
  expect(result.status).toBe('error');
  expect(result.diagnostics[0]?.code).toBe('INVALID_ARGUMENT');
});

test('preserves evidence for an explicitly requested file scope without a lexical match', async () => {
  const corpus = corpusFixture();
  const fileOnlyCorpus: Corpus = {
    ...corpus,
    entities: [...corpus.entities, {
      id: 'file:empty',
      kind: 'file',
      name: 'empty.ts',
      owner: null,
      signature: null,
      source: {
        corpusId: 'fixture', generationId: 'g1', path: 'src/empty.ts', sourceSha256: 'a'.repeat(64),
        normalizedSha256: null, snapshotId: null, lineStart: 1, lineEnd: 1,
      },
      evidenceLevel: 'literal-path',
    }],
  };
  const investigator = createRepositoryInvestigator({
    corpus: fileOnlyCorpus,
    readRanges: reader,
    route: 'investigate-relations',
    preferredScopes: ['src/empty.ts'],
    limits: { maxCandidates: 5, sourceHintLines: 3 },
  });

  const result = await investigator.investigate({
    query: 'qqqzzzxxyy',
    scope: ['src/empty.ts'],
  });

  expect(result.status).toBe('ok');
  expect(result.sourceHints.map((item) => item.path)).toContain('src/empty.ts');
  expect(result.primaryScopeCoverage.missing).toEqual([]);
});

test('treats an explicitly requested absent scope as terminal missing-scope evidence', async () => {
  let reads = 0;
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: async (ranges) => {
      reads += 1;
      return reader(ranges);
    },
    route: 'investigate',
    preferredScopes: ['src/missing-worker-pool'],
  });

  const result = await investigator.investigate({
    query: 'worker pool export',
    scope: ['src/missing-worker-pool'],
  });

  expect(result.status).toBe('insufficient');
  expect(result.reason).toBe('REQUESTED_SCOPE_MISSING');
  expect(result.candidates).toEqual([]);
  expect(result.evidence).toEqual([]);
  expect(result.sourceHints).toEqual([]);
  expect(result.primaryScopeCoverage).toEqual({
    covered: [],
    missing: ['src/missing-worker-pool'],
  });
  expect(result.diagnostics).toEqual([{
    code: 'REQUESTED_SCOPE_MISSING',
    details: { scopes: ['src/missing-worker-pool'] },
  }]);
  expect(reads).toBe(0);
});

test('treats an empty explicit scope list like an omitted scope', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: reader,
    route: 'investigate',
    preferredScopes: ['src/'],
  });

  const omitted = await investigator.investigate({ query: 'createSession' });
  const empty = await investigator.investigate({ query: 'createSession', scope: [] });

  expect(empty.status).toBe(omitted.status);
  expect(empty.candidates.map((item) => item.id)).toEqual(omitted.candidates.map((item) => item.id));
  expect(empty.primaryScopeCoverage).toEqual(omitted.primaryScopeCoverage);
});

test('普通斜杠短语不会变成缺失的硬路径范围', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: reader,
    route: 'investigate',
  });

  const result = await investigator.investigate({
    query: 'Find createSession code that validates/rejects absolute inputs',
  });

  expect(result.reason).not.toBe('REQUESTED_SCOPE_MISSING');
  expect(result.candidates.map((item) => item.path)).toContain('src/session.ts');
  expect(result.primaryScopeCoverage.missing).not.toContain('validates/rejects');
});

test('明确相对路径和文件路径仍可报告缺失范围', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: reader,
    route: 'investigate',
  });

  for (const [query, path] of [
    ['inspect ./new-area/missing', 'new-area/missing'],
    ['inspect new-area/missing.ts', 'new-area/missing.ts'],
  ] as const) {
    const result = await investigator.investigate({ query });
    expect(result.reason).toBe('REQUESTED_SCOPE_MISSING');
    expect(result.primaryScopeCoverage.missing).toEqual([path]);
  }
});

test('promotes an exact child path from the query and terminates when that child scope is absent', async () => {
  let reads = 0;
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: async (ranges) => {
      reads += 1;
      return reader(ranges);
    },
    route: 'investigate',
    preferredScopes: ['src/'],
  });

  const result = await investigator.investigate({
    query: 'src/missing-worker-pool export class interface type',
    scope: ['src/'],
  });

  expect(result.status).toBe('insufficient');
  expect(result.reason).toBe('REQUESTED_SCOPE_MISSING');
  expect(result.primaryScopeCoverage).toEqual({ covered: [], missing: ['src/missing-worker-pool'] });
  expect(result.diagnostics).toEqual([{
    code: 'REQUESTED_SCOPE_MISSING',
    details: { scopes: ['src/missing-worker-pool'] },
  }]);
  expect(reads).toBe(0);
});

test('promotes an existing child path from the query without inventing missing-scope evidence', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: reader,
    route: 'investigate',
    preferredScopes: ['src/'],
  });

  const result = await investigator.investigate({
    query: 'src/decode.ts decode export',
    scope: ['src/'],
  });

  expect(result.reason).not.toBe('REQUESTED_SCOPE_MISSING');
  expect(result.candidates.some((item) => item.path === 'src/decode.ts')).toBe(true);
});

test('a unique filename in a scoped query reads that file without unrelated candidates', async () => {
  const base = corpusFixture();
  const paths = ['src/bytes.ts', 'src/file-integrity.ts', 'src/file-integrity-sync.ts'];
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      ...paths.flatMap((path) => {
        const source = sourceRef(path, 1, 20);
        return [
          { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
            owner: null, signature: null, source, evidenceLevel: 'literal-path' as const },
          { id: `symbol:${path}`, kind: 'symbol' as const,
            name: path === 'src/bytes.ts' ? 'toHex' : 'verifyFileIntegrity', owner: null,
            signature: `export function ${path === 'src/bytes.ts' ? 'toHex' : 'verifyFileIntegrity'}() { return true; }`,
            source: sourceRef(path, 10, 15), evidenceLevel: 'syntax' as const },
        ];
      }),
    ],
  };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate', preferredScopes: ['src/'],
  });

  const result = await investigator.investigate({
    query: 'SHA-256 hex digest byte length structured errors bytes.ts', scope: ['src/'],
  });

  expect(result.status).toBe('ok');
  expect(result.candidates.map((item) => item.path)).toEqual(['src/bytes.ts']);
  expect(result.evidence.map((item) => item.path)).toEqual(['src/bytes.ts']);
  expect(result.sourceHints.every((item) => item.path === 'src/bytes.ts')).toBe(true);
});

test('an ambiguous filename retains both matching paths', async () => {
  const base = corpusFixture();
  const paths = ['src/left/bytes.ts', 'src/right/bytes.ts'];
  const corpus: Corpus = { ...base, entities: [
    ...base.entities,
    ...paths.map((path) => ({ id: `file:${path}`, kind: 'file' as const, name: 'bytes.ts',
      owner: null, signature: null, source: sourceRef(path, 1, 10), evidenceLevel: 'literal-path' as const })),
  ] };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate', includeEvidence: false,
    preferredScopes: ['src/'],
  });

  const result = await investigator.investigate({ query: 'bytes.ts', scope: ['src/'] });

  expect(result.candidates.map((item) => item.path)).toEqual(expect.arrayContaining(paths));
});

test('唯一裸文件名与完整相对路径使用相同的证据范围', async () => {
  const base = corpusFixture();
  const paths = ['src/bytes.ts', 'src/sibling.ts'];
  const corpus: Corpus = { ...base, entities: [
    ...base.entities,
    ...paths.flatMap((path) => [
      { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
        owner: null, signature: null, source: sourceRef(path, 1, 20),
        evidenceLevel: 'literal-path' as const },
      { id: `symbol:${path}`, kind: 'symbol' as const,
        name: path === 'src/bytes.ts' ? 'toHex' : 'inspectBytes', owner: null,
        signature: 'byte length structured error', source: sourceRef(path, 10, 12),
        evidenceLevel: 'syntax' as const },
    ]),
  ] };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate',
  });
  const bare = await investigator.investigate({ query: 'byte length structured error bytes.ts' });
  const full = await investigator.investigate({ query: 'byte length structured error src/bytes.ts' });
  expect(bare.candidates.map((item) => item.path)).toEqual(['src/bytes.ts']);
  expect(full.candidates.map((item) => item.path)).toEqual(['src/bytes.ts']);
  expect(full.sourceHints.every((item) => item.path === 'src/bytes.ts')).toBe(true);
  expect(full.sourceHints.map((item) => item.path)).toEqual(bare.sourceHints.map((item) => item.path));
});

test('keeps mixed explicit scopes searchable when at least one requested scope exists', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: reader,
    route: 'investigate',
    preferredScopes: ['src/', 'src/missing-worker-pool'],
  });

  const result = await investigator.investigate({
    query: 'createSession',
    scope: ['src/', 'src/missing-worker-pool'],
  });

  expect(result.status).toBe('ok');
  expect(result.reason).toBeUndefined();
  expect(result.candidates.length).toBeGreaterThan(0);
  expect(result.primaryScopeCoverage.covered).toContain('src/');
  expect(result.primaryScopeCoverage.missing).toContain('src/missing-worker-pool');
});

test('locate-only investigation never reads evidence or hint bodies', async () => {
  let reads = 0;
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: async (ranges) => {
      reads += 1;
      return reader(ranges);
    },
    route: 'investigate-relations',
    preferredScopes: ['src/'],
    promoteRelationEndpoints: true,
    includeEvidence: false,
  });

  const result = await investigator.investigate({ query: 'createSession' });

  expect(reads).toBe(0);
  expect(result.evidence).toEqual([]);
  expect(result.sourceHints).toEqual([]);
  expect(result.candidates.length).toBeGreaterThan(0);
});

test('locate and evidence candidates include a second relevant file when one file has many matching symbols', async () => {
  const base = corpusFixture();
  const contractSource = sourceRef('src/contracts.ts', 1, 1);
  const graphSource = sourceRef('src/graph.ts', 1, 1);
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      { id: 'file:contracts', kind: 'file', name: 'contracts.ts', owner: null,
        signature: null, source: contractSource, evidenceLevel: 'literal-path' },
      { id: 'file:graph', kind: 'file', name: 'graph.ts', owner: null,
        signature: null, source: graphSource, evidenceLevel: 'literal-path' },
      ...[1, 2, 3].map((number) => ({
        id: `symbol:contract:${number}`, kind: 'symbol' as const,
        name: `workspaceGraphDiagnosticUnresolved${number}`, owner: null,
        signature: `export type workspaceGraphDiagnosticUnresolved${number} = string`,
        source: contractSource, evidenceLevel: 'syntax' as const,
      })),
      { id: 'symbol:graph', kind: 'symbol', name: 'buildWorkspaceGraph', owner: null,
        signature: 'export const buildWorkspaceGraph = () => true',
        source: graphSource, evidenceLevel: 'syntax' },
    ],
  };
  for (const includeEvidence of [false, true]) {
    const investigator = createRepositoryInvestigator({
      corpus, readRanges: reader, route: 'investigate', preferredScopes: ['src/'],
      includeEvidence,
    });

    const result = await investigator.investigate({ query: 'workspace graph diagnostic unresolved' });

    expect(result.status).toBe('ok');
    expect(result.candidates.map((item) => item.path)).toContain('src/graph.ts');
    expect(result.candidates.find((item) => item.path === 'src/graph.ts')?.name)
      .toBe('buildWorkspaceGraph');
    expect(new Set(result.candidates.map((item) => item.path)).size).toBe(result.candidates.length);
    if (includeEvidence) {
      const evidencePaths = result.evidence.map((item) => item.path);
      expect(evidencePaths).toEqual(expect.arrayContaining(['src/contracts.ts', 'src/graph.ts']));
      expect(new Set(evidencePaths).size).toBe(evidencePaths.length);
    }
  }
});

test('locate represents a source with its matching operation instead of an incidental local symbol', async () => {
  const base = corpusFixture();
  const source = sourceRef('src/codec.ts', 1, 1);
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      { id: 'file:codec', kind: 'file', name: 'codec.ts', owner: null,
        signature: null, source, evidenceLevel: 'literal-path' },
      { id: 'symbol:encoder', kind: 'symbol', name: 'encoder', owner: null,
        signature: 'const encoder = new TextEncoder()', source,
        evidenceLevel: 'syntax' },
      { id: 'symbol:encodeJsonLine', kind: 'symbol', name: 'encodeJsonLine', owner: null,
        signature: 'export function encodeJsonLine(value: unknown): Uint8Array', source,
        evidenceLevel: 'syntax' },
    ],
  };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate', preferredScopes: ['src/'],
    includeEvidence: false,
  });

  const result = await investigator.investigate({
    query: 'JSON Lines streaming text encoder stringify newline LF framing',
  });

  expect(result.candidates.find((item) => item.path === 'src/codec.ts')?.id)
    .toBe('symbol:encodeJsonLine');
});

test('default evidence includes a complete medium-sized implementation when its match is direct', async () => {
  const base = corpusFixture();
  const source = sourceRef('src/graph.ts', 11, 42);
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      { id: 'file:medium-graph', kind: 'file', name: 'graph.ts', owner: null,
        signature: null, source: sourceRef('src/graph.ts', 1, 50), evidenceLevel: 'literal-path' },
      { id: 'symbol:medium-graph', kind: 'symbol', name: 'createWorkspaceGraph', owner: null,
        signature: 'export function createWorkspaceGraph(): WorkspaceGraph', source,
        evidenceLevel: 'syntax' },
    ],
  };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate', preferredScopes: ['src/graph.ts'],
  });

  const result = await investigator.investigate({ query: 'createWorkspaceGraph' });

  expect(result.candidates[0]?.id).toBe('symbol:medium-graph');
  expect(result.evidence[0]?.lineStart).toBe(11);
  expect(result.evidence[0]?.lineEnd).toBe(42);
});

test('diagnostic prose locates the workspace graph builder despite a generic find instruction', async () => {
  const base = corpusFixture();
  const path = 'packages/workspace-graph/src/graph.ts';
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      { id: 'symbol:cycles', kind: 'symbol', name: 'findWorkspaceCycles', owner: null,
        signature: 'export function findWorkspaceCycles(): WorkspaceGraphCycle[]',
        source: sourceRef(path, 80, 119), evidenceLevel: 'syntax' },
      { id: 'symbol:builder', kind: 'symbol', name: 'createWorkspaceGraph', owner: null,
        signature: 'export function createWorkspaceGraph(): WorkspaceGraph',
        source: sourceRef(path, 11, 42), evidenceLevel: 'syntax' },
    ],
  };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate', preferredScopes: ['packages/workspace-graph/src'],
  });

  const result = await investigator.investigate({
    query: 'Locate workspace graph diagnostics. Find regression causing unresolved workspace dependencies; identify source to edit.',
  });

  expect(result.candidates[0]?.id).toBe('symbol:builder');
  expect(result.evidence[0]?.lineStart).toBe(11);
  expect(result.evidence[0]?.lineEnd).toBe(42);
});

test('evidence includes the full small source file around a short matching wrapper', async () => {
  const base = corpusFixture();
  const path = 'src/portable-path.ts';
  const lines = Array.from({ length: 26 }, (_, index) => `// line ${index + 1}`);
  lines[7] = 'export function validatePortableRelativePath(path: string) {';
  lines[23] = 'export function normalizePortableRelativePath(path: string) {';
  const file = sourceRef(path, 1, lines.length);
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      { id: 'file:portable', kind: 'file', name: 'portable-path.ts', owner: null,
        signature: null, source: file, evidenceLevel: 'literal-path' },
      { id: 'symbol:normalize', kind: 'symbol', name: 'normalizePortableRelativePath', owner: null,
        signature: 'export function normalizePortableRelativePath(path: string): string',
        source: sourceRef(path, 24, 26), evidenceLevel: 'syntax' },
    ],
  };
  const investigator = createRepositoryInvestigator({
    corpus, route: 'investigate', preferredScopes: [path],
    readRanges: async (ranges) => ({ schemaVersion: 1, status: 'ok', corpusId: 'fixture',
      generationId: 'g1', diagnostics: [], texts: ranges.map((source) => ({ source, path,
        lineStart: source.lineStart, lineEnd: source.lineEnd,
        text: lines.slice(source.lineStart - 1, source.lineEnd).join('\n') })) }),
  });

  const result = await investigator.investigate({ query: 'normalizePortableRelativePath' });

  expect(result.candidates[0]?.id).toBe('symbol:normalize');
  expect(result.evidence[0]?.lineStart).toBe(1);
  expect(result.evidence[0]?.lineEnd).toBe(26);
  expect(result.evidence[0]?.text).toContain('validatePortableRelativePath');
  expect(result.evidence[0]?.wholeFile).toBe(true);

  const bounded = createRepositoryInvestigator({
    corpus, route: 'investigate', preferredScopes: [path], limits: { evidenceLines: 24 },
    readRanges: async (ranges) => ({ schemaVersion: 1, status: 'ok', corpusId: 'fixture',
      generationId: 'g1', diagnostics: [], texts: ranges.map((source) => ({ source, path,
        lineStart: source.lineStart, lineEnd: source.lineEnd,
        text: lines.slice(source.lineStart - 1, source.lineEnd).join('\n') })) }),
  });
  const boundedResult = await bounded.investigate({ query: 'normalizePortableRelativePath' });
  expect(boundedResult.evidence[0]?.lineStart).toBe(24);
  expect(boundedResult.evidence[0]?.lineEnd).toBe(26);
  expect(boundedResult.evidence[0]?.wholeFile).toBe(false);
});

test('cross-package candidate ranking favors matching operations over incidental local variables', async () => {
  const base = corpusFixture();
  const rows = [
    ['packages/path-safety/src/node/root-containment.ts', 'normalizedLogicalPath',
      'normalizedLogicalPath = validatePortableRelativePath(logicalPath)'],
    ['packages/path-safety/src/portable-path.ts', 'normalizePortableRelativePath',
      'normalizePortableRelativePath = (path: string): string => ('],
    ['packages/repository-files/src/repository-files.ts', 'absolutePath',
      'absolutePath = resolve(root, submodulePath)'],
    ['packages/repository-files/src/paths.ts', 'normalizeRepositoryPath',
      'normalizeRepositoryPath = (path: string): string => path'],
  ] as const;
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      ...rows.flatMap(([path, name, signature]) => [
        { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
          owner: null, signature: null, source: sourceRef(path, 1, 30),
          evidenceLevel: 'literal-path' as const },
        { id: `symbol:${name}`, kind: 'symbol' as const, name, owner: null, signature,
          source: sourceRef(path, 15, 17), evidenceLevel: 'syntax' as const },
      ]),
    ],
  };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate',
    preferredScopes: ['packages/path-safety/src', 'packages/repository-files/src'],
  });

  const result = await investigator.investigate({
    query: 'portable path normalization Windows separators absolute device network traversal',
  });

  expect(result.candidates.map((item) => item.path)).toContain('packages/repository-files/src/paths.ts');
  expect(result.candidates.map((item) => item.name)).toContain('normalizeRepositoryPath');
});

test('正文匹配可召回符号名称未覆盖任务词的源文件', async () => {
  const base = corpusFixture();
  const paths = ['src/codec.ts', 'src/checksum.ts', 'src/length.ts', 'src/errors.ts'];
  const names = ['encode', 'parseChecksumFrame', 'calculateByteLength', 'createStructuredError'];
  const corpus: Corpus = { ...base, entities: [
    ...base.entities,
    ...paths.flatMap((path, index) => [
      { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
        owner: null, signature: null, source: sourceRef(path, 1, 2),
        evidenceLevel: 'literal-path' as const },
      { id: `symbol:${path}`, kind: 'symbol' as const, name: names[index] ?? '',
        owner: null, signature: `export function ${names[index]}()`, source: sourceRef(path, 1, 2),
        evidenceLevel: 'syntax' as const },
    ]),
  ] };
  const investigator = createRepositoryInvestigator({
    corpus, route: 'investigate', preferredScopes: ['src/'],
    readRanges: async (ranges) => ({ schemaVersion: 1, status: 'ok', corpusId: 'fixture',
      generationId: 'g1', diagnostics: [], texts: ranges.map((source) => ({
        source, path: source.path, lineStart: source.lineStart, lineEnd: source.lineEnd,
        text: source.path === 'src/codec.ts'
          ? 'export function encode() {\n  return checksumFrameByteLengthStructuredError(); }'
          : 'export const unrelated = true;\nexport const value = 1;',
      })) }),
  });

  const result = await investigator.investigate({
    query: 'checksum frame byte length structured error', scope: ['src/'],
  });

  expect(result.candidates.map((item) => item.path)).toContain('src/codec.ts');
  expect(result.evidence.map((item) => item.path)).toContain('src/codec.ts');
});

test('query acronym locates a second component represented by expanded identifier words', async () => {
  const base = corpusFixture();
  const names = ['encodeJsonLine', 'createJsonLinesDecoder', 'jsonLinesErrorCodes',
    'encodeQuickFrameEvent', 'createQuickFrameEventDecoder'];
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      ...names.flatMap((name, index) => {
        const path = `packages/${index >= 3 ? 'frame-events' : 'json-lines'}/src/${name}.ts`;
        const source = sourceRef(path, 1, 8);
        return [
          { id: `file:${name}`, kind: 'file' as const, name: `${name}.ts`, owner: null,
            signature: null, source, evidenceLevel: 'literal-path' as const },
          { id: `symbol:${name}`, kind: 'symbol' as const, name, owner: null,
            signature: `export function ${name}() { return true; }`, source,
            evidenceLevel: 'syntax' as const },
        ];
      }),
    ],
  };
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: reader, route: 'investigate', includeEvidence: false,
    preferredScopes: ['packages/json-lines/src', 'packages/frame-events/src'],
  });

  const result = await investigator.investigate({
    query: 'JSON Lines QFE encoder streaming text framing LF event terminator',
  });

  expect(result.candidates.map((item) => item.path)).toContain('packages/frame-events/src/encodeQuickFrameEvent.ts');
  expect(result.candidates.map((item) => item.name)).toContain('encodeQuickFrameEvent');
  expect(result.candidates.slice(0, 2).map((item) => item.name)).toEqual(expect.arrayContaining([
    'encodeJsonLine', 'encodeQuickFrameEvent',
  ]));
});

test('finds Chinese comment evidence and keeps unrelated cross-language queries insufficient', async () => {
  const base = corpusFixture();
  const source = sourceRef('src/retry.ts', 1, 2);
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      { id: 'file:retry', kind: 'file', name: 'retry.ts', owner: null, signature: null, source, evidenceLevel: 'literal-path' },
    ],
  };
  const read = async (ranges: readonly SourceRef[]) => ({
    schemaVersion: 1 as const, status: 'ok' as const, corpusId: 'fixture', generationId: 'g1', diagnostics: [],
    texts: ranges.map((item) => ({
      source: item, path: item.path, lineStart: item.lineStart, lineEnd: item.lineEnd,
      text: item.path === 'src/retry.ts' ? '// 超时重试\nexport const retry = true;' : 'export const unrelated = true;',
    })),
  });
  const investigator = createRepositoryInvestigator({
    corpus, readRanges: read, route: 'investigate', preferredScopes: ['src/'],
  });

  const chinese = await investigator.investigate({ query: '超时重试' });
  expect(chinese.status).toBe('ok');
  expect(chinese.sourceHints.some((item) => item.path === 'src/retry.ts' && item.text.includes('超时重试'))).toBe(true);

  const unrelated = await investigator.investigate({ query: 'database timeout' });
  expect(unrelated.status).toBe('insufficient');
  expect(unrelated.sourceHints).toEqual([]);
});
test('keeps exact short symbols usable through the investigator without body reads', async () => {
  const base = corpusFixture();
  const source = sourceRef('src/id.ts', 1, 1);
  const corpus: Corpus = {
    ...base,
    entities: [
      ...base.entities,
      { id: 'file:id', kind: 'file', name: 'id.ts', owner: null, signature: null, source, evidenceLevel: 'literal-path' },
      { id: 'symbol:id', kind: 'symbol', name: 'id', owner: null, signature: 'export const id = 1', source, evidenceLevel: 'syntax' },
    ],
  };
  let bodyReads = 0;
  const investigator = createRepositoryInvestigator({
    corpus,
    readRanges: async () => { bodyReads += 1; return reader([]); },
    route: 'investigate', preferredScopes: ['src/'], includeEvidence: false,
  });
  const result = await investigator.investigate({ query: 'id' });
  expect(result.candidates[0]?.id).toBe('symbol:id');
  expect(bodyReads).toBe(0);
});

test('显式请求范围在补充证据与实际读取中保持收窄', async () => {
  const base = corpusFixture();
  const files = [
    { path: 'src/alpha/main.ts', name: 'inspectValue', text: 'export function inspectValue() { return 1; }' },
    { path: 'src/beta/other.ts', name: 'inspectValueDetails',
      text: 'export function inspectValueDetails() { return "inspect validate numeric value"; }' },
  ];
  const corpus: Corpus = { ...base, entities: [...base.entities, ...files.flatMap(({ path, name, text }) => [
    { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
      owner: null, signature: null, source: sourceRef(path, 1, 1), evidenceLevel: 'literal-path' as const },
    { id: `symbol:${path}`, kind: 'symbol' as const, name, owner: null, signature: text,
      source: sourceRef(path, 1, 1), evidenceLevel: 'syntax' as const },
  ])] };
  for (const request of [
    { query: 'inspect value', scope: ['src/alpha/'] },
    { query: 'inspect src/alpha/ value', scope: ['src/'] },
    { query: 'inspect src/alpha/main.ts value', scope: ['src/'] },
    { query: 'inspect main.ts value', scope: ['src/'] },
    { query: 'inspect value', scope: ['src/alpha/', 'src/missing/'] },
  ]) {
    const reads: string[] = [];
    const investigator = createRepositoryInvestigator({ corpus, route: 'investigate',
      preferredScopes: ['src/'], readRanges: async (ranges) => {
        reads.push(...ranges.map((range) => range.path));
        return { schemaVersion: 1, status: 'ok', corpusId: 'fixture', generationId: 'g1',
          diagnostics: [], texts: ranges.map((source) => ({ source, path: source.path,
            lineStart: source.lineStart, lineEnd: source.lineEnd,
            text: files.find((file) => file.path === source.path)?.text ?? '' })) };
      } });
    const result = await investigator.investigate({ ...request, evidenceBudget: { maxBytes: 4096 } });
    expect(result.candidates.map((item) => item.path)).toContain('src/alpha/main.ts');
    expect([...result.evidence, ...result.sourceHints].every((item) => item.path === 'src/alpha/main.ts')).toBe(true);
    expect([...new Set(reads)]).toEqual(['src/alpha/main.ts']);
  }
});

test('正文高频注释不能挤掉已明确命名的第三个符号', async () => {
  const base = corpusFixture();
  const named = ['alphaHandler', 'betaHandler', 'gammaHandler'];
  const files = named.map((name) => ({ path: `src/${name}.ts`, name,
    text: `export function ${name}() { return 1; }` }));
  files.push({ path: 'src/notes.ts', name: 'unrelated',
    text: `// ${Array.from({ length: 12 }, () => named.join(' ')).join(' ')}\nexport const unrelated = 0;` });
  const corpus: Corpus = { ...base, entities: [...base.entities, ...files.flatMap(({ path, name, text }) => [
    { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
      owner: null, signature: null, source: sourceRef(path, 1, text.split('\n').length),
      evidenceLevel: 'literal-path' as const },
    { id: `symbol:${path}`, kind: 'symbol' as const, name, owner: null,
      signature: `export function ${name}()`, source: sourceRef(path, 1, 1),
      evidenceLevel: 'syntax' as const },
  ])] };
  const investigator = createRepositoryInvestigator({ corpus, route: 'investigate',
    preferredScopes: ['src/'], readRanges: async (ranges) => ({ schemaVersion: 1,
      status: 'ok', corpusId: 'fixture', generationId: 'g1', diagnostics: [],
      texts: ranges.map((source) => ({ source, path: source.path,
        lineStart: source.lineStart, lineEnd: source.lineEnd,
        text: files.find((file) => file.path === source.path)?.text.split('\n')
          .slice(source.lineStart - 1, source.lineEnd).join('\n') ?? '' })) }) });
  const result = await investigator.investigate({ query: named.join(' '), scope: ['src/'],
    evidenceBudget: { maxBytes: 30_000 } });
  expect(result.candidates.map((item) => item.name).sort()).toEqual([...named].sort());
  expect(result.evidence.map((item) => item.path)).not.toContain('src/notes.ts');
});

test('三至五个明确符号在顺序和文件长度变化后仍优先于注释噪声', async () => {
  const base = corpusFixture();
  const allNames = ['alphaHandler', 'betaHandler', 'gammaHandler', 'deltaWorker', 'epsilonWorker'];
  for (const count of [3, 5]) {
    for (const rotation of [0, 2]) {
      const names = allNames.slice(0, count);
      const queryNames = [...names.slice(rotation), ...names.slice(0, rotation)];
      const files = names.map((name, index) => ({ path: `src/${name}.ts`, name,
        text: `export function ${name}() { return ${index}; }\n${'// filler\n'.repeat(index * 8)}` }));
      files.push({ path: 'src/notes.ts', name: 'unrelated',
        text: `// ${Array.from({ length: 20 }, () => queryNames.join(' ')).join(' ')}\nexport const unrelated = 0;` });
      const corpus: Corpus = { ...base, entities: [...base.entities, ...files.flatMap(({ path, name, text }) => [
        { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
          owner: null, signature: null, source: sourceRef(path, 1, text.split('\n').length),
          evidenceLevel: 'literal-path' as const },
        { id: `symbol:${path}`, kind: 'symbol' as const, name, owner: null,
          signature: `export function ${name}()`, source: sourceRef(path, 1, 1),
          evidenceLevel: 'syntax' as const },
      ])] };
      const investigator = createRepositoryInvestigator({ corpus, route: 'investigate',
        preferredScopes: ['src/'], limits: { maxCandidates: count },
        readRanges: async (ranges) => ({ schemaVersion: 1, status: 'ok',
          corpusId: 'fixture', generationId: 'g1', diagnostics: [], texts: ranges.map((source) => ({
            source, path: source.path, lineStart: source.lineStart, lineEnd: source.lineEnd,
            text: files.find((file) => file.path === source.path)?.text.split('\n')
              .slice(source.lineStart - 1, source.lineEnd).join('\n') ?? '',
          })) }) });
      const result = await investigator.investigate({ query: queryNames.join(' '), scope: ['src/'],
        evidenceBudget: { maxBytes: 40_000 } });
      expect(result.candidates.map((item) => item.name).sort()).toEqual([...names].sort());
      expect(result.evidence.map((item) => item.path)).not.toContain('src/notes.ts');
    }
  }
});

test('多组件查询保留每个明确命名目录中的实现，避免单一目录占满候选', async () => {
  const base = corpusFixture();
  const rows = [
    ['packages/json-lines/src/codec.ts', 'encodeJsonLine',
      'export function encodeJsonLine(value: unknown): Uint8Array'],
    ['packages/server-sent-events/src/encoder.ts', 'encodeServerSentEvent',
      'export function encodeServerSentEvent(event: ServerSentEvent): Uint8Array'],
    ['packages/server-sent-events/src/contracts.ts', 'ServerSentEvent',
      'export interface ServerSentEvent'],
    ['packages/server-sent-events/src/decoder.ts', 'createServerSentEventDecoder',
      'export function createServerSentEventDecoder()'],
  ] as const;
  const corpus: Corpus = { ...base, entities: [...base.entities,
    ...rows.flatMap(([path, name, signature]) => [
      { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
        owner: null, signature: null, source: sourceRef(path, 1, 12),
        evidenceLevel: 'literal-path' as const },
      { id: `symbol:${name}`, kind: 'symbol' as const, name, owner: null, signature,
        source: sourceRef(path, 2, 4), evidenceLevel: 'syntax' as const },
    ])] };
  const investigator = createRepositoryInvestigator({ corpus, route: 'investigate',
    preferredScopes: ['packages/'], includeEvidence: false, readRanges: reader });
  const query = 'Find the JSON Lines streaming text encoder and the Server-Sent Events (SSE) '
    + 'streaming text encoder. Show encoding functions, JSONL NDJSON SSE data newline terminators.';
  const result = await investigator.investigate({ query, scope: ['packages/'] });
  expect(result.candidates.map((item) => item.path)).toContain('packages/json-lines/src/codec.ts');
  expect(result.candidates.map((item) => item.path)).toContain('packages/server-sent-events/src/encoder.ts');
});

test('不同目录深度的组件名称也能参与候选覆盖', async () => {
  const base = corpusFixture();
  const rows = [
    ['workspace/modules/alpha-reader/parse.ts', 'parseAlphaReader'],
    ['workspace/modules/beta-writer/emit.ts', 'emitBetaWriter'],
    ['workspace/modules/beta-writer/contracts.ts', 'BetaWriter'],
    ['workspace/modules/beta-writer/validate.ts', 'validateBetaWriter'],
  ] as const;
  const corpus: Corpus = { ...base, entities: [...base.entities,
    ...rows.flatMap(([path, name]) => [
      { id: `file:${path}`, kind: 'file' as const, name: path.split('/').at(-1) ?? '',
        owner: null, signature: null, source: sourceRef(path, 1, 5),
        evidenceLevel: 'literal-path' as const },
      { id: `symbol:${name}`, kind: 'symbol' as const, name, owner: null,
        signature: `export function ${name}()`, source: sourceRef(path, 1, 5),
        evidenceLevel: 'syntax' as const },
    ])] };
  const investigator = createRepositoryInvestigator({ corpus, route: 'investigate',
    preferredScopes: ['workspace/'], includeEvidence: false, readRanges: reader });
  const result = await investigator.investigate({
    query: 'Inspect alpha reader and beta writer implementations for cross-component compatibility',
  });
  expect(result.candidates.map((item) => item.path))
    .toContain('workspace/modules/alpha-reader/parse.ts');
  expect(result.candidates.map((item) => item.path))
    .toContain('workspace/modules/beta-writer/emit.ts');
});
