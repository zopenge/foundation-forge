import { resolve } from 'node:path';
import process from 'node:process';
import { createManagedExecution } from '../../dist/node/managed-execution.js';
import { ReleaseError } from '../../dist/node/errors.js';
import { prepareCheckout } from '../../dist/node/managed-checkout.js';
import { assertManagedPaths, openManagedSlot } from '../../dist/node/managed-paths.js';
import { createManagedSession } from '../../dist/node/managed-process.js';
import { createManagedStateStore } from '../../dist/node/managed-state.js';
import { freezeManagedSource } from '../../dist/node/source.js';
import { diagnostic, readConfig } from '../../dist/node/workspace-release.js';

/** 只准备真实推送失败阶段；不生成完整安装、检查或成功发布的证据。 */
async function pushPhase(cwd, mode, sha) {
  if (!['rejected-main', 'accepted-main-crash', 'development-response-lost'].includes(mode)
    || !/^[a-f0-9]{40}$/u.test(sha ?? '')) throw new Error('FIXTURE_PUSH_PHASE_INPUT');
  const startedAt = new Date().toISOString(), config = await readConfig(resolve(cwd, 'release.config.json'));
  const original = createManagedExecution(cwd, config, undefined, []);
  const source = await freezeManagedSource(cwd, 'release.config.json', original);
  if (source.sha !== sha) throw new Error('FIXTURE_PUSH_PHASE_SHA');
  const admitted = await openManagedSlot(source, original);
  // 来源准入真实执行；阶段组件随后只使用真实路径、原始锁与原子状态守卫。
  const guard = async () => { await assertManagedPaths(admitted.paths); await admitted.assertMetadataOwned(); };
  const slot = { ...admitted, lock: { assertOwned: guard, release: () => admitted.lock.release() },
    store: createManagedStateStore(admitted.paths, source, admitted.slotId, guard) };
  const session = await createManagedSession(slot, 'publish'), fixturePushes = [];
  await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot,
    sourceRoot: source.root, configPath: source.configPath,
    latestPublish: { sha, runId: slot.runId, configSha256: source.configSha256 } });
  const executionAt = path => createManagedExecution(path, config, undefined, []);
  // checkout准备使用真实Git；推送才是此fixture声明的受管进程边界。
  await prepareCheckout({ ...session, execution: executionAt(slot.paths.checkoutRoot), executionAt });
  const push = async (branch, effect, stage) => {
    session.state.stage = stage; session.state.effects[effect] = 'unknown'; session.state.pendingPush = effect;
    await session.persist();
    fixturePushes.push(`${sha}:refs/heads/${branch}`);
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
} catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
