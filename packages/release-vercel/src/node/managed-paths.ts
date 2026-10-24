import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { Execution } from './execution.js';
import { record, ReleaseError } from './errors.js';
import type { FrozenSource, ManagedPaths, ManagedSlot } from './release-context.js';
import { assertPathChain, fileIdentity, measureManagedUsage, pathExists, readBoundedJson, sameIdentity, within } from './managed-io.js';
import { gitBlob, gitRecords } from './git-stream.js';
import { acquireLock } from './lock.js';
import { createManagedStateStore } from './managed-state.js';
import { currentCoordinator } from './process-identities.js';
import { assertNoGitContext } from './git-context.js';
import { hasVerifiedManagedClosure } from './managed-closure.js';
import { hasFinalizedRetirement } from './retirement-record.js';

export async function assertManagementUntracked(source: FrozenSource, execution: Execution): Promise<void> {
  assertNoGitContext();
  if (source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const pathspec = (path: string) => process.platform === 'win32' ? `:(icase,literal)${path}` : `:(literal)${path}`;
  const managementPaths = [source.config.source.slotPath, '.tmp/forge-vercel-release'], paths = managementPaths.map(pathspec);
  let tracked = false;
  await gitRecords(execution, ['ls-files', '-z', '--', ...paths], () => { tracked = true; });
  // ls-tree 的旧版本不支持 icase magic；逐层核对真实 tree 名称，不遗漏大小写路径。
  const cache = new Map<string, { name: string; type: string; oid: string }[]>();
  const entries = async (tree: string) => {
    let values = cache.get(tree);
    if (!values) {
      values = [];
      await gitRecords(execution, ['ls-tree', '-z', tree], record => {
        const match = /^\d{6} (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(record);
        if (!match?.[1] || !match[2] || !match[3]) throw new ReleaseError('SLOT_PATH', { reason: 'HEAD_TREE' });
        values?.push({ type: match[1], oid: match[2], name: match[3] });
      });
      cache.set(tree, values);
    }
    return values;
  };
  for (const path of managementPaths) {
    let trees = ['HEAD']; const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      const next: string[] = [];
      for (const tree of trees) for (const entry of await entries(tree)) {
        if ((process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) !== (process.platform === 'win32' ? part.toLowerCase() : part)) continue;
        if (index === parts.length - 1 || entry.type !== 'tree') tracked = true;
        else next.push(entry.oid);
      }
      trees = next;
    }
  }
  if (tracked) throw new ReleaseError('SLOT_PATH', { reason: 'TRACKED_MANAGEMENT_PATH' });
}

async function assertCommittedIgnore(source: FrozenSource, execution: Execution, path: string): Promise<void> {
  let output: string;
  try { output = await execution.git(['-c', 'core.quotepath=false', 'check-ignore', '--no-index', '-v', '--', path]); }
  catch (error) { if (error instanceof ReleaseError && error.details.exitCode === 1) throw new ReleaseError('SLOT_PATH', { reason: 'NOT_IGNORED' }); throw error; }
  const fields = /^([^\r\n]+):[1-9]\d*:([^\t\r\n]*)\t[^\r\n]+$/u.exec(output);
  const origin = fields?.[1], pattern = fields?.[2];
  if (!origin || !pattern || pattern.startsWith('!') || !within(source.root, resolve(source.root, origin)) || origin.startsWith('.git/')) throw new ReleaseError('SLOT_PATH', { reason: 'NOT_COMMITTED_IGNORED' });
  try {
    const oid = await execution.git(['rev-parse', '--verify', `${source.sha}:${origin.replaceAll('\\', '/')}`]);
    // latin1 保留每个原始字节；只消除 CRLF/LF 差异，不执行 clean filter 或忽略规则变更。
    const lines = (bytes: Buffer) => bytes.toString('latin1').replaceAll('\r\n', '\n');
    if (lines(await readFile(resolve(source.root, origin))) !== lines(await gitBlob(execution, oid))) throw new ReleaseError('SLOT_PATH');
  } catch { throw new ReleaseError('SLOT_PATH', { reason: 'IGNORE_NOT_COMMITTED' }); }
}
export async function resolveManagedPaths(source: FrozenSource, execution: Execution): Promise<ManagedPaths> {
  if (source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const slotRoot = resolve(source.root, source.config.source.slotPath), anchorPath = resolve(source.root, '.tmp/forge-vercel-release/managed.json');
  if (!within(source.root, slotRoot) || slotRoot === source.root || within(slotRoot, anchorPath) || within(dirname(anchorPath), slotRoot)) throw new ReleaseError('SLOT_PATH');
  await assertPathChain(source.root, slotRoot); await assertPathChain(source.root, anchorPath);
  await assertCommittedIgnore(source, execution, `${source.config.source.slotPath}/`);
  await assertCommittedIgnore(source, execution, relative(source.root, anchorPath).replaceAll('\\', '/'));
  let tracked = false;
  await gitRecords(execution, ['ls-tree', '-rz', source.sha, '--', source.config.source.slotPath], () => { tracked = true; });
  if (tracked) throw new ReleaseError('SLOT_PATH', { reason: 'TRACKED_SLOT' });
  await assertManagementUntracked(source, execution);
  return { sourceRoot: source.root, slotRoot, checkoutRoot: resolve(slotRoot, 'checkout'), anchorPath,
    ownershipPath: resolve(slotRoot, 'ownership.json'), statePath: resolve(slotRoot, 'state.json'),
    lockPath: resolve(slotRoot, 'run.lock'), recoveryLockPath: resolve(slotRoot, 'recover.lock'),
    sourceIdentity: await fileIdentity(source.root), slotIdentity: await pathExists(slotRoot) ? await fileIdentity(slotRoot) : { dev: '', ino: '' } };
}
export async function assertManagedPaths(paths: ManagedPaths): Promise<void> {
  await assertPathChain(paths.sourceRoot, paths.slotRoot); await assertPathChain(paths.sourceRoot, paths.anchorPath);
  if (!sameIdentity(await fileIdentity(paths.sourceRoot), paths.sourceIdentity) || !sameIdentity(await fileIdentity(paths.slotRoot), paths.slotIdentity)
    || paths.sourceIdentity.dev !== paths.slotIdentity.dev) throw new ReleaseError('SLOT_PATH', { reason: 'ROOT_REPLACED' });
  if (await pathExists(paths.checkoutRoot)) {
    await assertPathChain(paths.slotRoot, paths.checkoutRoot);
    const gitRoot = resolve(paths.checkoutRoot, '.git');
    if (await pathExists(gitRoot)) {
      await assertPathChain(paths.slotRoot, gitRoot);
      if (!(await lstat(gitRoot)).isDirectory() || await pathExists(resolve(gitRoot, 'commondir')) || await pathExists(resolve(gitRoot, 'objects/info/alternates'))) throw new ReleaseError('SLOT_PATH', { reason: 'EXTERNAL_GIT' });
    }
  }
}
export async function openManagedSlot(source: FrozenSource, execution: Execution): Promise<ManagedSlot> {
  let paths = await resolveManagedPaths(source, execution);
  const existingAnchor = record(await readBoundedJson(paths.anchorPath, 65_536));
  const anchored = Object.keys(existingAnchor).length > 0;
  if (anchored && (existingAnchor.schemaVersion !== 2 || existingAnchor.sourceRoot !== source.root || existingAnchor.configPath !== source.configPath || existingAnchor.slotPath !== paths.slotRoot)) {
    throw new ReleaseError('SLOT_STATE', { reason: 'MANAGEMENT_REBINDING' });
  }
  if (anchored && !await pathExists(paths.slotRoot)) throw new ReleaseError('SLOT_FOREIGN', { reason: 'ANCHORED_SLOT_MISSING' });
  const runId = randomUUID(), coordinator = await currentCoordinator(execution.signal);
  await mkdir(dirname(paths.slotRoot), { recursive: true });
  await mkdir(dirname(paths.anchorPath), { recursive: true });
  let created = false;
  try { await mkdir(paths.slotRoot); created = true; }
  catch (error) { if (record(error).code !== 'EEXIST') throw error; }
  paths = { ...paths, slotIdentity: await fileIdentity(paths.slotRoot) };
  let slotId: string = randomUUID();
  if (!created) {
    let owner;
    try { owner = record(await readBoundedJson(paths.ownershipPath, 65_536)); }
    catch { throw new ReleaseError('SLOT_FOREIGN'); }
    if (owner.schemaVersion !== 2 || typeof owner.slotId !== 'string' || !/^[a-f0-9-]{36}$/u.test(owner.slotId)
      || owner.sourceRoot !== source.root || owner.configPath !== source.configPath || owner.repository !== source.config.git.repository
      || !sameIdentity(record(owner.sourceIdentity), paths.sourceIdentity)
      || !sameIdentity(record(owner.slotIdentity), paths.slotIdentity)) throw new ReleaseError('SLOT_FOREIGN');
    slotId = owner.slotId;
    if (anchored && existingAnchor.slotId !== slotId) throw new ReleaseError('SLOT_STATE', { reason: 'ANCHOR_SLOT_ID' });
    const allowed = ['ownership.json', 'run.lock', 'recover.lock', 'state.json', 'checkout', 'latest-check.json', 'latest-publish.json', 'command-gate.json', 'command-result.json', 'retirement.json', 'retirement-work', 'retired'];
    if ((await readdir(paths.slotRoot)).some(name => !allowed.includes(name))) throw new ReleaseError('SLOT_FOREIGN', { reason: 'UNKNOWN_ENTRY' });
  }
  await assertManagedPaths(paths);
  if (await pathExists(paths.recoveryLockPath)) throw new ReleaseError('LOCKED', { reason: 'RECOVERY_ACTIVE' });
  if (source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const usage = await measureManagedUsage(paths), budget = source.config.source;
  const ownerJson = JSON.stringify({ schemaVersion: 2, slotId, sourceRoot: source.root,
    configPath: source.configPath, repository: source.config.git.repository, sourceIdentity: paths.sourceIdentity, slotIdentity: paths.slotIdentity });
  const admissionBytes = 1024 + (created ? Buffer.byteLength(ownerJson) : 0);
  if (Buffer.byteLength(ownerJson) > 65_536 || usage.bytes + admissionBytes > budget.maxBytes || usage.freeBytes - admissionBytes < budget.minFreeBytes) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'SLOT_ADMISSION' });
  const rawLock = await acquireLock(paths.lockPath, { runId, identity: coordinator });
  const management = new Execution(source.root, source.config, undefined, []);
  const assertOwned = async () => { await assertManagedPaths(paths); await assertManagementUntracked(source, management); await rawLock.assertOwned(); };
  const lock = { assertOwned, release: async () => { await assertOwned(); await rawLock.release(); } };
  try {
    if (await pathExists(paths.recoveryLockPath)) throw new ReleaseError('LOCKED', { reason: 'RECOVERY_ACTIVE' });
    if (created) await writeFile(paths.ownershipPath, ownerJson, { encoding: 'utf8', flag: 'wx' });
    const guard = async () => { await assertManagedPaths(paths); await lock.assertOwned(); };
    const store = createManagedStateStore(paths, source, slotId, guard);
    const state = await store.read();
    if (state && (state.status !== 'closed' || state.pendingPush || Object.values(state.effects).includes('unknown') || !state.processes.every(hasVerifiedManagedClosure)) && !await hasFinalizedRetirement(paths, state)) throw new ReleaseError('RECOVERY_REQUIRED', { runId: state.runId });
    return { paths, source, slotId, lock, store, runId, coordinator };
  } catch (error) { await lock.release(); throw error; }
}
