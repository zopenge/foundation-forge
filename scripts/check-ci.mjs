import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDistDigests, collectWorkspaceFingerprint } from './check-fingerprint.mjs';
import { runFullCheck } from './check-full.mjs';
import { openCheckCancellation } from './check-cancellation.mjs';
import { parseCoverageShard, persistCoverageShard, readCoverageShardArtifacts } from './ci-coverage-shards.mjs';
import { runWorkspaceCoverageBatch, mergeWorkspaceCoverage } from './run-workspace-coverage-batch.mjs';
import { discoverPackageTestFiles } from './run-workspace-coverage.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { createTestRunContext } from './test-run-context.mjs';
import { testWorkerLimit } from './test-worker-budget.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function parseCiCheckArguments(args) {
  if (args.length === 1 && args[0] === '--gates') return { kind: 'gates' };
  if (args.length !== 2) throw new Error('CI_ARGUMENT: --shard <index/count> | --merge <directory>');
  if (['--shard', '--coverage-shard'].includes(args[0])) {
    parseCoverageShard(args[1]); return { kind: args[0] === '--shard' ? 'shard' : 'coverage-shard', shard: args[1] };
  }
  if (args[0] === '--merge' && args[1] && !args[1].startsWith('--')) return { kind: 'merge', directory: args[1] };
  throw new Error('CI_ARGUMENT');
}

async function binding(model, input) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  if (head.status !== 0 || !/^[a-f0-9]{40}$/u.test(head.stdout.trim())) throw new Error('CI_SOURCE_UNKNOWN');
  const commit = head.stdout.trim();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw new Error('CI_SOURCE_CHANGED');
  return { commit, source: digest(input.files), dist: digest(await collectDistDigests(model.packages)),
    node: process.version, platform: process.platform, architecture: process.arch, workers: testWorkerLimit(), repositoryRoot,
    vitest: JSON.parse(await readFile(resolve(repositoryRoot, 'node_modules/vitest/package.json'), 'utf8')).version,
    run: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null };
}

async function assertUnchanged(before) {
  const after = await collectWorkspaceFingerprint(repositoryRoot);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('CI_SOURCE_CHANGED');
}

export async function runCiCheck(args, signal) {
  signal?.throwIfAborted();
  const command = parseCiCheckArguments(args);
  if (testWorkerLimit() !== 1) throw new Error('CI_SINGLE_WORKER_REQUIRED');
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const before = await collectWorkspaceFingerprint(repositoryRoot);
  if (command.kind === 'gates') {
    await runFullCheck({ signal, label: 'check:ci-gates', coverage: false });
    await assertUnchanged(before); signal?.throwIfAborted();
    process.stdout.write('CI common gates complete; coverage shards and their complete merge are still required.\n');
    return;
  }
  if (command.kind === 'shard' || command.kind === 'coverage-shard') {
    const shard = parseCoverageShard(command.shard), directory = resolve(repositoryRoot, 'tmp/ci-shards');
    try { await lstat(resolve(directory, `part-${shard.index}`)); throw new Error('CI_SHARD_OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let partial, context;
    const coverage = async options => {
      context = options.context; partial = await runWorkspaceCoverageBatch({ ...options, shard: command.shard });
    };
    if (command.kind === 'shard') await runFullCheck({ signal, label: 'check:ci-shard', coverage });
    else {
      // build由同一干净CI作业显式执行；本入口只产出部分coverage，不代替公共门禁或full收据。
      context = await createTestRunContext({ packages: model.packages, workers: 1, signal });
      const failures = [];
      try { await coverage({ packages: model.packages, context }); } catch (error) { failures.push(error); }
      try { await context.finalize(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'CI coverage and cleanup failed', { cause: failures[0] });
    }
    if (!partial || !context) throw new Error('CI_SHARD_INCOMPLETE');
    await assertUnchanged(before);
    const blob = await readFile(partial.blobPath), part = {
      schemaVersion: 1, kind: 'ci-coverage-shard', shard, binding: await binding(model, before),
      files: partial.result.testResults.map(value => relative(repositoryRoot, value.name).replaceAll('\\', '/')),
      passed: partial.result.numPassedTests, skipped: partial.result.numPendingTests,
      audit: JSON.parse(await readFile(resolve(context.root, 'summary.json'), 'utf8')),
      environmentDigest: before.environmentDigest,
    };
    signal?.throwIfAborted();
    await persistCoverageShard({ repositoryRoot, directory, blob, part });
    signal?.throwIfAborted();
    process.stdout.write(`CI coverage shard ${command.shard} completed; full evidence requires merge.\n`);
    return;
  }
  const selected = model.packages.filter(value => value.manifest.scripts?.['test:coverage']);
  const expectedFiles = (await Promise.all(selected.map(async value => (await discoverPackageTestFiles(value.packageRoot))
    .map(file => relative(repositoryRoot, resolve(value.packageRoot, file)).replaceAll('\\', '/'))))).flat();
  const artifacts = await readCoverageShardArtifacts({ repositoryRoot, directory: resolve(repositoryRoot, command.directory),
    binding: await binding(model, before), expectedFiles });
  signal?.throwIfAborted();
  const context = await createTestRunContext({ packages: model.packages, workers: 1, signal });
  const failures = [];
  try {
    const blobsDirectory = resolve(context.root, 'blobs'); await mkdir(blobsDirectory);
    for (const blob of artifacts.blobs) await writeFile(resolve(blobsDirectory, blob.name), blob.bytes, { flag: 'wx' });
    await mergeWorkspaceCoverage({ packages: selected, context, blobsDirectory, expected: artifacts.expected });
  } catch (error) { failures.push(error); }
  try { await context.finalize(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'CI merge and cleanup failed', { cause: failures[0] });
  await assertUnchanged(before);
  signal?.throwIfAborted();
  process.stdout.write('CI shard merge complete; all current test files and coverage verified.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cancellation;
  try {
    cancellation = openCheckCancellation();
    process.stdout.write(`check cancellation file: ${cancellation.path}\n`);
    await runCiCheck(process.argv.slice(2), cancellation.signal);
    cancellation.assertRunning();
  } catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
  finally { cancellation?.close(); }
}
