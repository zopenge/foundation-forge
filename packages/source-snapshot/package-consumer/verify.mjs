import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import { TextEncoder } from 'node:util';
import {
  buildSourceTextPackage, classifySourcePath, compareSnapshotFiles,
  createSnapshotManifest, defineSourceSnapshotPolicy, planSnapshotRetention,
  reconstructSourceText, scanSourceSecrets, stageSourceTextFile,
} from '@openge/forge-source-snapshot';
import {
  collectSourceInventory, exportRepositorySnapshot, inspectSourceSnapshotRetention,
  planRepositorySnapshot, pruneSourceSnapshots, runSourceSnapshotCli,
  verifyPublishedSourceSnapshot,
} from '@openge/forge-source-snapshot/node';

await import('./core-v2.mjs');
await import('./node-v2.mjs');

const now = Date.parse('2026-09-15T00:00:00.000Z');
const snapshot = await createSnapshotManifest({ projectId: 'installed-consumer', policyVersion: '1', publishedAt: now, repositories: [], files: [], objects: [] });
assert.match(snapshot.snapshotId, /^snapshot-[a-f0-9]{64}$/u);
assert.deepEqual(compareSnapshotFiles(null, snapshot), { added: [], changed: [], removed: [] });
assert.deepEqual(planSnapshotRetention({ snapshots: [snapshot], currentSnapshotId: snapshot.snapshotId, objectPaths: [], now }).removeObjectPaths, []);
const policy = defineSourceSnapshotPolicy({ textExtensions: ['.ts'], binaryExtensions: ['.png'], sensitiveBasenamePrefixes: ['.env.'] });
assert.deepEqual(classifySourcePath({ path: 'src/a.ts', exists: true, type: 'file' }, policy), { action: 'include', ruleId: 'text' });
assert.equal(classifySourcePath({ path: '.env.local', exists: true, type: 'file' }, policy).ruleId, 'sensitive-path');
const staged = await stageSourceTextFile({ path: 'src/a.ts', group: 'core', bytes: new TextEncoder().encode('export const a = 1\n') });
const packed = await buildSourceTextPackage([staged], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000 });
assert.equal(reconstructSourceText(packed, 'src/a.ts'), staged.text);
const secret = `ghp_${'A1b'.repeat(12)}`;
const findings = scanSourceSecrets([{ path: 'src/leak.ts', text: secret }]);
assert.equal(findings.length, 1); assert.equal(JSON.stringify(findings).includes(secret), false);

const base = await mkdtemp(join(process.cwd(), 'source-snapshot-consumer-'));
const source = join(base, 'source'); const target = join(base, 'target'); const state = join(base, 'state');
await Promise.all([mkdir(source), mkdir(target), mkdir(state)]);
try {
  execFileSync('git', ['init', '--quiet'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'snapshot-test@example.invalid'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'Snapshot Test'], { cwd: source });
  await writeFile(join(source, '.gitignore'), 'ignored/\n', 'utf8');
  await writeFile(join(source, 'tracked.ts'), 'export const tracked = 1\n', 'utf8');
  await writeFile(join(source, 'untracked.ts'), 'export const untracked = 1\n', 'utf8');
  await mkdir(join(source, 'ignored')); await writeFile(join(source, 'ignored', 'hidden.ts'), '', 'utf8');
  execFileSync('git', ['add', '.gitignore', 'tracked.ts'], { cwd: source });
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: source });
  const inventory = await collectSourceInventory({ sourceRoot: source });
  assert.deepEqual(inventory.entries.map(value => value.projectPath), ['.gitignore', 'tracked.ts', 'untracked.ts']);

  const options = {
    sourceRoot: source, projectId: 'tarball-consumer', policyVersion: '1', publishedAt: now,
    policy: { textExtensions: ['.ts'], textBasenames: ['.gitignore'] },
    pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20, maxObjectBytesTotal: 100_000 },
    groupForPath: path => path.endsWith('.ts') ? 'code' : 'root',
  };
  const planned = await planRepositorySnapshot(options); assert.equal(planned.status, 'READY');
  const exportOptions = { ...options, targetRoot: target, lockPath: join(state, 'publish.lock'), ownerId: 'tarball-owner' };
  const first = await exportRepositorySnapshot(exportOptions); assert.equal(first.status, 'LOCAL_VERIFIED');
  const verified = await verifyPublishedSourceSnapshot({ targetRoot: target, ownerId: 'tarball-owner' });
  assert.equal(verified.status, 'LOCAL_VERIFIED');
  const second = await exportRepositorySnapshot({ ...exportOptions, publishedAt: now + 1 }); assert.equal(second.status, 'NO_CHANGES');
  const status = await inspectSourceSnapshotRetention({ targetRoot: target, ownerId: 'tarball-owner', now }); assert.equal(status.snapshotCount, 1);
  const preview = await pruneSourceSnapshots({ targetRoot: target, ownerId: 'tarball-owner', lockPath: join(state, 'publish.lock'), now, dryRun: true }); assert.equal(preview.status, 'PRUNE_PREVIEW');

  const config = join(base, 'source-snapshot.config.mjs');
  await writeFile(config, `export default ${JSON.stringify({ projectId:'tarball-cli',policyVersion:'1',sourceRoot:source,targetRoot:join(base,'cli-target'),lockPath:join(state,'cli.lock'),ownerId:'cli-owner',policy:{textExtensions:['.ts'],textBasenames:['.gitignore']},pack:{targetObjectBytes:4096,maxObjectBytes:8192,maxObjectCount:20,maxObjectBytesTotal:100000} })};\nexport const groupForPath = path => path.endsWith('.ts') ? 'code' : 'root';\n`, 'utf8');
  await mkdir(join(base, 'cli-target'));
  const output = []; const cli = await runSourceSnapshotCli(['plan','--config',config,'--json'], { cwd: base, now: () => now, stdout: value => output.push(value), stderr: value => { throw new Error(value); } });
  assert.equal(cli.exitCode, 0); assert.equal(JSON.parse(output.join('')).status, 'READY');
  assert.equal(output.join('').includes('export const tracked'), false);

  const bin = fileURLToPath(new URL('./cli.js', import.meta.resolve('@openge/forge-source-snapshot')));
  const binRun = spawnSync(process.execPath, [bin, 'plan', '--config', config, '--json'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  assert.equal(binRun.status, 0, binRun.stdout + binRun.stderr); assert.equal(JSON.parse(binRun.stdout).status, 'READY'); assert.equal(binRun.stdout.includes('export const tracked'), false);
  const linkedBinDirectory = join(base, 'linked-bin');
  await symlink(dirname(bin), linkedBinDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedBinRun = spawnSync(process.execPath, [join(linkedBinDirectory, 'cli.js'), 'plan', '--config', config, '--json'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  assert.equal(linkedBinRun.status, 0, linkedBinRun.stdout + linkedBinRun.stderr); assert.equal(JSON.parse(linkedBinRun.stdout).status, 'READY');
} finally { await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }

const browser = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  const core = await import('@openge/forge-source-snapshot');
  assert.equal(typeof core.createSnapshotManifest, 'function');
  assert.equal(typeof core.buildSourceTextPackage, 'function');
  await assert.rejects(import('@openge/forge-source-snapshot/node'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
assert.equal(browser.status, 0, browser.stdout + browser.stderr);
