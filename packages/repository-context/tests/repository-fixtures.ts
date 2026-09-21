import type { Corpus, Edge, Entity, SourceRef } from '../src/core/contracts.js';

const digest = 'a'.repeat(64);

export const sourceRef = (path: string, lineStart = 1, lineEnd = lineStart + 2): SourceRef => ({
  corpusId: 'fixture',
  generationId: 'g1',
  path,
  sourceSha256: digest,
  normalizedSha256: null,
  snapshotId: null,
  lineStart,
  lineEnd,
});

const entity = (id: string, name: string, path: string, owner: string | null = null): Entity => ({
  id,
  kind: 'symbol',
  name,
  owner,
  signature: `function ${name}(): void`,
  source: sourceRef(path),
  evidenceLevel: 'syntax',
});

const edge = (from: string, to: string | null, resolution: Edge['resolution'] = 'resolved'): Edge => ({
  from,
  to,
  kind: 'symbol-reference',
  resolution,
  evidence: sourceRef(`${from}.ts`, 1, 1),
  evidenceLevel: 'syntax',
  configurationDigest: null,
});

export const corpusFixture = (options: { readonly duplicateEntity?: boolean } = {}): Corpus => {
  const entities: Entity[] = [
    entity('symbol:session:createSession', 'createSession', 'src/session.ts', 'Session'),
    entity('symbol:session:decodeSession', 'decodeSession', 'src/decode.ts', 'Session'),
    entity('symbol:network:createSession', 'createSession', 'src/network.ts', 'Network'),
    {
      ...entity('file:session', 'session.ts', 'src/session.ts'),
      kind: 'file',
      owner: null,
      signature: null,
      source: sourceRef('src/session.ts', 1, 6),
    },
  ];
  const firstEntity = entities[0];
  if (options.duplicateEntity === true && firstEntity !== undefined) entities.push({ ...firstEntity });
  return {
    corpusId: 'fixture',
    generationId: 'g1',
    corpusState: 'frozen',
    coverage: 'complete-in-declared-scope',
    entities,
    edges: [
      edge('symbol:session:createSession', 'symbol:session:decodeSession'),
      edge('symbol:session:decodeSession', 'symbol:session:createSession'),
      edge('symbol:network:createSession', null, 'unresolved'),
    ],
  };
};
