import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { prepareRepositorySnapshot } from '../src/node/prepared-pipeline.js';
import { buildSnapshotCoverageFromPlan } from '../src/node/snapshot-coverage.js';
import { resolveSnapshotCoverage } from '../src/snapshot-coverage.js';
import { runGit } from './node-fixtures.js';
const policy = { sensitiveBasenames: ['.env'], binaryExtensions: ['.bin'], textExtensions: ['.ts', '.json'], textBasenames: ['.gitignore'] };
async function fixture(blocked = false) {
  const work = resolve(import.meta.dirname, '../../../.tmp/coverage-tests'); await mkdir(work, { recursive: true });
  const base = await mkdtemp(join(work, 'case-')); const sourceRoot = join(base, 'source'); await mkdir(sourceRoot);
  await runGit(sourceRoot, ['init', '--quiet']); await writeFile(join(sourceRoot, '.gitignore'), 'ignored/\n');
  await runGit(sourceRoot, ['add', '.gitignore']); await runGit(sourceRoot, ['commit', '--quiet', '-m', 'fixture']);
  await writeFile(join(sourceRoot, 'main.ts'), 'export const value = 1;\n');
  await writeFile(join(sourceRoot, '.env'), 'PRIVATE_FIXTURE_ONLY=yes\n'); await writeFile(join(sourceRoot, 'blob.bin'), new Uint8Array([0, 1]));
  await mkdir(join(sourceRoot, 'ignored')); await writeFile(join(sourceRoot, 'ignored', 'not-enumerated.ts'), 'hidden\n');
  if (blocked) { await writeFile(join(sourceRoot, 'unknown.xyz'), 'unknown'); await writeFile(join(sourceRoot, 'bad.ts'), new Uint8Array([255, 255])); }
  const prepared = await prepareRepositorySnapshot({ sourceRoot, workRoot: join(base, 'spool'), projectId: 'coverage-node', policyVersion: '1', publishedAt: 1,
    policy, groupForPath: () => 'code', pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100000, textFormatVersion: 2 } });
  return { base, sourceRoot, prepared };
}
test('derives coverage from the frozen capture without reopening or enumerating the source', async () => {
  const { base, sourceRoot, prepared } = await fixture();
  try {
    await rename(sourceRoot, join(base, 'source-offline'));
    const report = await buildSnapshotCoverageFromPlan(prepared.plan, { policy, policyVersion: '1', producer: 'test-consumer' });
    expect(report.summary.enumeratedCandidates).toBe(prepared.plan.inventory.entries.length);
    expect(report.summary.fullTextFiles).toBe(2); expect(report.summary.redactedCandidates).toBe(1);
    expect(JSON.stringify(report)).not.toContain('.env'); expect(JSON.stringify(report)).not.toContain(base);
    expect(resolveSnapshotCoverage(report, 'blob.bin').state).toBe('policy-excluded');
    expect(resolveSnapshotCoverage(report, 'ignored/not-enumerated.ts').sourceExistence).toBe('unknown');
    const changed = { ...prepared.plan, inventory: { ...prepared.plan.inventory, entries: prepared.plan.inventory.entries.map(entry => ({ ...entry, size: entry.size + 1 })) } };
    await expect(buildSnapshotCoverageFromPlan(changed, { policy, policyVersion: '1', producer: 'test-consumer' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await expect(buildSnapshotCoverageFromPlan(prepared.plan, { policy: { ...policy, sensitiveBasenames: [] }, policyVersion: '1', producer: 'test-consumer' })).rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
  } finally { await prepared.dispose(); await rm(base, { recursive: true, force: true }); }
});
test('blocked captures retain mutually exclusive review and decoding reasons without promising bodies', async () => {
  const { base, prepared } = await fixture(true);
  try {
    const report = await buildSnapshotCoverageFromPlan(prepared.plan, { policy, policyVersion: '1', producer: 'test-consumer' });
    expect(report.snapshotId).toBeNull(); expect(report.summary.fullTextFiles).toBe(0);
    expect(resolveSnapshotCoverage(report, 'unknown.xyz').state).toBe('pending-review');
    expect(resolveSnapshotCoverage(report, 'bad.ts').state).toBe('unsupported-decoding');
    expect(resolveSnapshotCoverage(report, 'main.ts').fullTextAvailable).toBe(false);
  } finally { await prepared.dispose(); await rm(base, { recursive: true, force: true }); }
});
test('rejects a ready plan that contradicts its recorded capture failures', async () => {
  const { base, prepared } = await fixture();
  try {
    const forged = { ...prepared.plan, contentIssues: [{ path: 'never-enumerated.ts', code: 'SOURCE_READ_FAILED' }] };
    await expect(buildSnapshotCoverageFromPlan(forged, { policy, policyVersion: '1', producer: 'test-consumer' })).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
  } finally { await prepared.dispose(); await rm(base, { recursive: true, force: true }); }
});
