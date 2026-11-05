import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { createManagedExecution } from '../../dist/node/managed-execution.js';
import { ReleaseError } from '../../dist/node/errors.js';
import { prepareCheckout } from '../../dist/node/managed-checkout.js';
import { assertManagedPaths, openManagedSlot } from '../../dist/node/managed-paths.js';
import { createManagedSession } from '../../dist/node/managed-process.js';
import { createManagedStateStore } from '../../dist/node/managed-state.js';
import { freezeManagedSource } from '../../dist/node/source.js';
import { diagnostic, readConfig } from '../../dist/node/workspace-release.js';

// 成功路径只保留内存时序；提前失败时再输出有界阶段与原始结构原因。
const started = performance.now(), workerStartedAt = new Date().toISOString(), phases = [];
const phase = name => { if (phases.length < 16) phases.push({ name, milliseconds: Math.floor(performance.now() - started) }); };
function failureDetails(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 3) return {};
  const details = {};
  for (const key of ['name', 'code', 'syscall']) if (typeof error[key] === 'string') details[key] = error[key].slice(0, 128);
  for (const key of ['reason', 'step', 'stage', 'phase', 'ioCode', 'causeCode', 'causePhase', 'causeSyscall', 'causeFile',
    'nativeCode', 'exitCode', 'budgetMs', 'elapsedMs', 'scanAttempts', 'entriesVisited']) {
    const value = error.details?.[key];
    if (typeof value === 'string') details[key] = value.slice(0, 128);
    else if (typeof value === 'number' && Number.isFinite(value)) details[key] = value;
  }
  if (error.cause) details.cause = failureDetails(error.cause, depth + 1);
  return details;
}

/** 只准备真实推送失败阶段；不生成完整安装、检查或成功发布的证据。 */
async function pushPhase(cwd, mode, sha) {
  phase('input');
  if (!['rejected-main', 'accepted-main-crash', 'development-response-lost'].includes(mode)
    || !/^[a-f0-9]{40}$/u.test(sha ?? '')) throw new Error('FIXTURE_PUSH_PHASE_INPUT');
  phase('config');
  const startedAt = new Date().toISOString(), config = await readConfig(resolve(cwd, 'release.config.json'));
  const original = createManagedExecution(cwd, config, undefined, []);
  phase('source');
  const source = await freezeManagedSource(cwd, 'release.config.json', original);
  if (source.sha !== sha) throw new Error('FIXTURE_PUSH_PHASE_SHA');
  phase('slot');
  const admitted = await openManagedSlot(source, original);
  // 来源准入真实执行；阶段组件随后只使用真实路径、原始锁与原子状态守卫。
  const guard = async () => { await assertManagedPaths(admitted.paths); await admitted.assertMetadataOwned(); };
  const slot = { ...admitted, lock: { assertOwned: guard, release: () => admitted.lock.release() },
    store: createManagedStateStore(admitted.paths, source, admitted.slotId, guard) };
  phase('session');
  const session = await createManagedSession(slot, 'publish'), fixturePushes = [];
  phase('anchor');
  await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot,
    sourceRoot: source.root, configPath: source.configPath,
    latestPublish: { sha, runId: slot.runId, configSha256: source.configSha256 } });
  const executionAt = path => createManagedExecution(path, config, undefined, []);
  // checkout准备使用真实Git；推送才是此fixture声明的受管进程边界。
  phase('checkout');
  await prepareCheckout({ ...session, execution: executionAt(slot.paths.checkoutRoot), executionAt });
  const push = async (branch, effect, stage) => {
    phase(`${stage}-intent`);
    session.state.stage = stage; session.state.effects[effect] = 'unknown'; session.state.pendingPush = effect;
    await session.persist();
    fixturePushes.push(`${sha}:refs/heads/${branch}`);
    phase(stage);
    const output = await session.execution.git(['push', '--porcelain', config.git.remote, `${sha}:refs/heads/${branch}`]);
    if (mode === 'development-response-lost' && effect === 'developmentPush') {
      throw new ReleaseError('GIT_FAILED', { reason: 'FIXTURE_RESPONSE_LOST' });
    }
    session.state.effects[effect] = output.split(/\r?\n/u).some(line => line.startsWith('=')
      && line.includes(`:refs/heads/${branch}\t`)) ? 'already-current' : 'pushed';
    delete session.state.pendingPush; await session.persist();
  };
  let failure;
  try {
    await push(config.git.developmentBranch, 'developmentPush', 'push-dev');
    await push(config.git.releaseBranch, 'releasePush', 'push-main');
    throw new Error('FIXTURE_PUSH_PHASE_DID_NOT_FAIL_OR_BLOCK');
  } catch (error) { failure = diagnostic(error); }
  let closed = false;
  try { await session.assertStopped(); closed = true; } catch { /* 缺少真实停止证明时保留unknown和原始锁。 */ }
  session.state.status = closed ? 'closed' : 'unknown'; await session.persist();
  const report = { schemaVersion: 2, command: 'publish', ok: false, startedAt, finishedAt: new Date().toISOString(),
    steps: session.steps, effects: session.state.effects, stage: session.state.stage, error: failure,
    sourceRoot: source.root, candidateSha: sha, configPath: source.configPath, configSha256: source.configSha256,
    slotId: slot.slotId, runId: slot.runId, executionRoot: slot.paths.checkoutRoot,
    processes: { status: closed ? 'closed' : 'unknown', knownCount: session.state.processes.filter(value => value.identity).length } };
  await slot.store.writeReceipt('publish', { schemaVersion: 2, slotId: slot.slotId, source, report });
  // 故意保留当前锁，由原公开恢复/下一次发布入口核验退出实例、归档并释放。
  return { ...report, fixtureBoundary: 'push-phase', fixturePushes };
}

try {
  if (process.argv.length !== 5) throw new Error('FIXTURE_PUSH_PHASE_INPUT');
  process.stdout.write(JSON.stringify(await pushPhase(...process.argv.slice(2))));
  process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ fixture: 'push-phase', pid: process.pid, startedAt: workerStartedAt, phases, error: failureDetails(error) })}\n${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
