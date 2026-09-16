import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';
import {
  buildSnapshotReadIndex,
  buildSourceTextPackage,
  collectSnapshotObjectRequirements,
  createTextSnapshotManifest,
  readSnapshotText,
  stageSourceTextFile,
  validateSnapshotEvidence,
} from '@openge/forge-source-snapshot';

const bytes = value => new TextEncoder().encode(value);
const staged = await stageSourceTextFile({
  path: 'src/neutral.ts', group: 'code', bytes: bytes('export const neutral = 1\r\n'),
});
const packed = await buildSourceTextPackage([staged], {
  targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10,
  maxObjectBytesTotal: 100_000, textFormatVersion: 2,
});
const manifest = await createTextSnapshotManifest({
  projectId: 'neutral-core-consumer', policyVersion: '2', publishedAt: 1,
  repositories: [], textPackage: packed,
});
const index = buildSnapshotReadIndex(manifest);
assert.equal(index.files[0]?.formatVersion, 2);
const requirements = collectSnapshotObjectRequirements(manifest, ['src/neutral.ts']);
assert.deepEqual(requirements.map(value => value.path), packed.objects.map(value => value.path));
const result = await readSnapshotText(
  manifest,
  packed.objects.map(object => ({ path: object.path, bytes: bytes(object.content) })),
  'src/neutral.ts',
  { maxObjectBytes: 8192, maxFileBytes: 100_000, maxTotalBytes: 100_000 },
);
assert.equal(result.text, 'export const neutral = 1\n');
assert.equal(result.assurance, 'normalized-text-verified');

const evidenceArtifact = bytes('neutral evidence artifact');
const evidence = await validateSnapshotEvidence(manifest, {
  evidenceId: 'tarball-evidence', snapshotId: manifest.snapshotId, producer: 'neutral-runner', producerVersion: '1',
  kind: 'unit', status: 'passed', collected: 1, passed: 1, failed: 0, skipped: 0,
  environment: { command: 'node not-executed.mjs', url: 'https://127.0.0.1:9/not-fetched', script: 'never-run' },
  artifactRefs: [{ artifactId: 'report', sha256: createHash('sha256').update(evidenceArtifact).digest('hex'), byteLength: evidenceArtifact.byteLength }],
}, [{ artifactId: 'report', bytes: evidenceArtifact }]);
assert.equal(evidence.schemaStatus, 'schema-valid');
assert.equal(evidence.sourceStatus, 'source-bound');
assert.equal(evidence.status, 'passed');
assert.equal(JSON.stringify(evidence).includes('neutral evidence artifact'), false);
