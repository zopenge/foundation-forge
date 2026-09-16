import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  buildSourceTextPackage,
  createTextSnapshotManifest,
  stageSourceTextFile,
  validateSnapshotEvidence,
} from '../../src/index.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const manifestFixture = async () => {
  const staged = await stageSourceTextFile({ path: 'src/main.ts', group: 'code', bytes: utf8('export const main = 1\n') });
  const textPackage = await buildSourceTextPackage([staged], {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10,
    maxObjectBytesTotal: 100_000, textFormatVersion: 2,
  });
  return createTextSnapshotManifest({
    projectId: 'evidence-fixture', policyVersion: '2', publishedAt: 1,
    repositories: [], textPackage,
  });
};
test('validates source-bound evidence and explicit artifact bytes without executing metadata strings', async () => {
  const manifest = await manifestFixture(); const artifact = utf8('artifact-body');
  const result = await validateSnapshotEvidence(manifest, {
    evidenceId: 'unit-1', snapshotId: manifest.snapshotId, producer: 'neutral-runner', producerVersion: '1.0.0',
    kind: 'unit', status: 'passed', collected: 3, passed: 3, failed: 0, skipped: 0,
    environment: { command: 'node never-run.mjs', url: 'https://127.0.0.1:9/not-fetched', script: 'throw new Error("never")' },
    artifactRefs: [{ artifactId: 'report', sha256: sha256(artifact), byteLength: artifact.byteLength }],
  }, [{ artifactId: 'report', bytes: artifact }]);
  expect(result).toMatchObject({
    schemaVersion: 1, snapshotId: manifest.snapshotId, evidenceId: 'unit-1',
    schemaStatus: 'schema-valid', sourceStatus: 'source-bound', kind: 'unit', status: 'passed', artifactCount: 1,
  });
  expect(result.environment).toEqual({ command: 'node never-run.mjs', script: 'throw new Error("never")', url: 'https://127.0.0.1:9/not-fetched' });
  expect(JSON.stringify(result)).not.toMatch(/artifact-body|testVerified|cloud.*verified/iu);
});
test('passed evidence rejects collected=0 and contradictory counters', async () => {
  const manifest = await manifestFixture();
  const base = {
    evidenceId: 'counts', snapshotId: manifest.snapshotId, producer: 'runner', producerVersion: '1',
    kind: 'unit' as const, status: 'passed' as const, environment: {}, artifactRefs: [],
  };
  await expect(validateSnapshotEvidence(manifest, { ...base, collected: 0, passed: 0, failed: 0, skipped: 0 }, []))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(validateSnapshotEvidence(manifest, { ...base, collected: 3, passed: 2, failed: 0, skipped: 0 }, []))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(validateSnapshotEvidence(manifest, { ...base, collected: 2, passed: 1, failed: 1, skipped: 0 }, []))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('old snapshot and artifact integrity mismatches fail source binding', async () => {
  const manifest = await manifestFixture(); const artifact = utf8('artifact');
  const evidence = {
    evidenceId: 'binding', snapshotId: manifest.snapshotId, producer: 'runner', producerVersion: '1',
    kind: 'integration' as const, status: 'failed' as const, collected: 1, passed: 0, failed: 1, skipped: 0,
    environment: {}, artifactRefs: [{ artifactId: 'report', sha256: sha256(artifact), byteLength: artifact.byteLength }],
  };
  await expect(validateSnapshotEvidence(manifest, { ...evidence, snapshotId: `snapshot-${'f'.repeat(64)}` }, [{ artifactId: 'report', bytes: artifact }]))
    .rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
  await expect(validateSnapshotEvidence(manifest, evidence, [{ artifactId: 'report', bytes: utf8('tampered') }]))
    .rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
});
test('metadata rejects oversized, over-deep and non-JSON values without echoing sensitive payloads', async () => {
  const manifest = await manifestFixture();
  const base = {
    evidenceId: 'metadata', snapshotId: manifest.snapshotId, producer: 'runner', producerVersion: '1',
    kind: 'static' as const, status: 'blocked' as const, collected: 0, passed: 0, failed: 0, skipped: 0, artifactRefs: [],
  };
  await expect(validateSnapshotEvidence(manifest, { ...base, environment: { note: 'x'.repeat(70_000) } }, []))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  let deep: unknown = 'leaf'; for (let index = 0; index < 12; index += 1) deep = { nested: deep };
  await expect(validateSnapshotEvidence(manifest, { ...base, environment: deep } as never, []))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(validateSnapshotEvidence(manifest, { ...base, environment: { callback: () => 'never' } } as never, []))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const secret = 'BLOCKED_MATCH_VALUE_123456';
  try { await validateSnapshotEvidence(manifest, { ...base, environment: { stdout: secret } } as never, []); throw new Error('expected rejection'); }
  catch (error) { expect(error).toMatchObject({ code: 'INVALID_INPUT' }); expect(JSON.stringify(error)).not.toContain(secret); }
});

test('blocked and not-run statuses remain unchanged and are never upgraded to passed', async () => {
  const manifest = await manifestFixture();
  for (const status of ['blocked', 'not-run'] as const) {
    const result = await validateSnapshotEvidence(manifest, {
      evidenceId: status, snapshotId: manifest.snapshotId, producer: 'runner', producerVersion: '1',
      kind: 'runtime', status, collected: 0, passed: 0, failed: 0, skipped: 0,
      environment: { reason: status }, artifactRefs: [],
    }, []);
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toMatch(/testVerified|status":"passed/iu);
  }
});
test('artifact references require an exact provided byte set and unique ids', async () => {
  const manifest = await manifestFixture(); const artifact = utf8('artifact');
  const evidence = {
    evidenceId: 'artifacts', snapshotId: manifest.snapshotId, producer: 'runner', producerVersion: '1',
    kind: 'static' as const, status: 'failed' as const, collected: 1, passed: 0, failed: 1, skipped: 0,
    environment: {}, artifactRefs: [{ artifactId: 'report', sha256: sha256(artifact), byteLength: artifact.byteLength }],
  };
  await expect(validateSnapshotEvidence(manifest, evidence, [])).rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
  await expect(validateSnapshotEvidence(manifest, evidence, [
    { artifactId: 'report', bytes: artifact }, { artifactId: 'report', bytes: artifact },
  ])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(validateSnapshotEvidence(manifest, evidence, [
    { artifactId: 'report', bytes: artifact }, { artifactId: 'extra', bytes: artifact },
  ])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
