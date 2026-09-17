import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { prepareRepositorySnapshot } from '../src/node/prepared-pipeline.js';
import { buildSnapshotProvenanceFromPlan, prepareSnapshotWithProvenance } from '../src/node/snapshot-provenance.js';
import { runGit } from './node-fixtures.js';
const policy = { sensitiveBasenames: ['.env'], textExtensions: ['.ts'], textBasenames: ['.gitignore'] };
const stamps = { exporter: { id: 'fixture-exporter', version: '1.0.0' }, grouping: { id: 'fixture-groups', version: '1', configDigest: 'a'.repeat(64) } };
async function fixture() {
  const work = resolve(import.meta.dirname, '../../../.tmp/provenance-tests'); await mkdir(work, { recursive: true });
  const base = await mkdtemp(join(work, 'case-')); const sourceRoot = join(base, 'source'); await mkdir(sourceRoot);
  await runGit(sourceRoot, ['init', '--quiet']); await writeFile(join(sourceRoot, '.gitignore'), 'ignored/\n');
  await writeFile(join(sourceRoot, 'main.ts'), 'export const value = 1;\n'); await runGit(sourceRoot, ['add', '.']);
  await runGit(sourceRoot, ['commit', '--quiet', '-m', 'fixture']); await writeFile(join(sourceRoot, 'main.ts'), 'export const value = 2;\n');
  await runGit(sourceRoot, ['add', 'main.ts']); await writeFile(join(sourceRoot, 'main.ts'), 'export const value = 3;\n');
  await writeFile(join(sourceRoot, 'new.ts'), 'export const added = true;\n'); await writeFile(join(sourceRoot, '.env'), 'PRIVATE_SOURCE_ONLY=yes\n');
  const options = { sourceRoot, workRoot: join(base, 'spool'), projectId: 'provenance-node', policyVersion: '1', publishedAt: 1, policy,
    groupForPath: () => 'code', pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100000, textFormatVersion: 2 as const } };
  return { base, options };
}
test('frozen records derive staged, unstaged and untracked provenance with source offline', async () => {
  const { base, options } = await fixture(); const prepared = await prepareRepositorySnapshot(options);
  try {
    await rename(options.sourceRoot, join(base, 'offline'));
    const bundle = await buildSnapshotProvenanceFromPlan(prepared.plan, { ...stamps, policy, policyVersion: '1' });
    expect(bundle.provenance).toMatchObject({ origin: 'capture-records', captureMode: 'working-tree', atomicity: 'not-guaranteed', bodyVerification: 'not-performed' });
    expect(bundle.provenance.fileStates?.find(f => f.path === 'main.ts')).toMatchObject({ tracked: true, untracked: false, staged: true, worktreeModified: true });
    expect(bundle.provenance.fileStates?.find(f => f.path === 'new.ts')).toMatchObject({ tracked: false, untracked: true, staged: false });
    expect(JSON.stringify(bundle.provenance)).not.toContain('.env'); expect(JSON.stringify(bundle.provenance)).not.toContain(base);
    expect(JSON.stringify(bundle.provenance)).not.toContain('PRIVATE_SOURCE_ONLY');
    expect(bundle.provenance.derived.coverageDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(bundle.provenance.derived.catalogDigest).toBe(bundle.catalog.root.sha256);
    const changed = { ...prepared.plan, freeze: { ...prepared.plan.freeze, files: prepared.plan.freeze.files.map(f => ({ ...f, sha256: '0'.repeat(64) })) } };
    await expect(buildSnapshotProvenanceFromPlan(changed, { ...stamps, policy, policyVersion: '1' })).rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
  } finally { await prepared.dispose(); await rm(base, { recursive: true, force: true }); }
});
test('capture freezes configuration before awaiting and keeps unknown grouping explicit', async () => {
  const { base, options } = await fixture();
  const mutable = { ...options, policy: { ...policy, textBasenames: [...policy.textBasenames] } };
  const promise = prepareSnapshotWithProvenance(mutable, { exporter: stamps.exporter }); mutable.policy.textBasenames.push('UNUSED');
  const captured = await promise;
  try {
    expect(captured.provenance.grouping).toBeNull(); expect(captured.provenance.reproducibility).toBe('unknown');
    const expected = await buildSnapshotProvenanceFromPlan(captured.prepared.plan, { policy, policyVersion: '1', exporter: stamps.exporter });
    expect(captured.provenance.policy).toEqual(expected.provenance.policy);
  } finally { await captured.prepared.dispose(); await rm(base, { recursive: true, force: true }); }
});
test('same policy version with changed rules and changed grouping producer changes provenance', async () => {
  const { base, options } = await fixture(); const a = await prepareRepositorySnapshot(options);
  try {
    const first = await buildSnapshotProvenanceFromPlan(a.plan, { ...stamps, policy, policyVersion: '1' });
    const second = await buildSnapshotProvenanceFromPlan(a.plan, { ...stamps, policy: { ...policy, textBasenames: [...policy.textBasenames, 'unused'] }, policyVersion: '1' });
    expect(first.provenance.snapshotId).toBe(second.provenance.snapshotId);
    expect(first.provenance.policy?.effectiveDigest).not.toBe(second.provenance.policy?.effectiveDigest);
    const third = await buildSnapshotProvenanceFromPlan(a.plan, { ...stamps, grouping: { ...stamps.grouping, version: '2' }, policy, policyVersion: '1' });
    expect(first.provenance.grouping).not.toEqual(third.provenance.grouping);
    expect(first.provenance.groupDecisionsDigest).toBe(third.provenance.groupDecisionsDigest);
  } finally { await a.dispose(); await rm(base, { recursive: true, force: true }); }
});
test('inventory and repository drift cannot be bound to a different frozen manifest', async () => {
  const { base, options } = await fixture(); const prepared = await prepareRepositorySnapshot(options);
  try {
    const changed = { ...prepared.plan, inventory: { ...prepared.plan.inventory, entries: prepared.plan.inventory.entries.map(e => ({ ...e, status: '??' })) } };
    await expect(buildSnapshotProvenanceFromPlan(changed, { ...stamps, policy, policyVersion: '1' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    const changedRepos = { ...prepared.plan, inventory: { ...prepared.plan.inventory, repositories: prepared.plan.inventory.repositories.map(r => ({ ...r, parentGitlink: 'f'.repeat(40) })) } };
    await expect(buildSnapshotProvenanceFromPlan(changedRepos, { ...stamps, policy, policyVersion: '1' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  } finally { await prepared.dispose(); await rm(base, { recursive: true, force: true }); }
});
test('same-operation capture rejects source changes during staging and releases spool', async () => {
  const { base, options } = await fixture();
  try {
    const { writeFileSync } = await import('node:fs'); const { readdir } = await import('node:fs/promises');
    const changed = { ...options, groupForPath: (path: string) => {
      if (path === 'main.ts') writeFileSync(join(options.sourceRoot, path), 'export const changedAfterRead = true;\n');
      return 'code';
    } };
    await expect(prepareSnapshotWithProvenance(changed, stamps)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await readdir(options.workRoot)).toEqual([]);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('blocked capture never manufactures a published source identity and cleans its spool', async () => {
  const { base, options } = await fixture();
  try {
    const { readdir } = await import('node:fs/promises'); await writeFile(join(options.sourceRoot, 'pending.xyz'), 'unknown file type');
    await expect(prepareSnapshotWithProvenance(options, stamps)).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
    expect(await readdir(options.workRoot)).toEqual([]);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('producer declarations reject non-string identities instead of coercing them', async () => {
  const { base, options } = await fixture(); const prepared = await prepareRepositorySnapshot(options);
  try {
    await expect(buildSnapshotProvenanceFromPlan(prepared.plan, { policy, policyVersion: '1', exporter: JSON.parse('{"id":123,"version":"1"}') }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally { await prepared.dispose(); await rm(base, { recursive: true, force: true }); }
});
