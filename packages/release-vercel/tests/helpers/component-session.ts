import { createManagedExecution } from '../../src/node/managed-execution.js';
import { assertManagedPaths } from '../../src/node/managed-paths.js';
import { createManagedStateStore } from '../../src/node/managed-state.js';
import type { ManagedSession, ManagedSlot } from '../../src/node/release-context.js';
import { readOnlyGit } from './component-command-runtime.mjs';

/** 协议组件保留目录身份、原始锁及真实存储；来源跟踪准入在独立集成边界验证。 */
export function protocolComponentSlot(slot: ManagedSlot): ManagedSlot {
  const assertOwned = async () => { await assertManagedPaths(slot.paths); await slot.assertMetadataOwned(); };
  const lock = { assertOwned, release: () => slot.lock.release() };
  return { ...slot, lock, store: createManagedStateStore(slot.paths, slot.source, slot.slotId, assertOwned) };
}

/** checkout/安装组件使用真实命令，不重复验证每个查询的受管进程日志；完整端到端保留该接入验证。 */
export function commandComponentSession(session: ManagedSession): ManagedSession {
  const executionAt = (cwd: string) => createManagedExecution(cwd, session.slot.source.config, session.execution.signal, []);
  return { ...session, execution: executionAt(session.slot.paths.checkoutRoot), executionAt };
}

/** 发布决策组件：只读 Git 查询仍实时执行；push、fetch、应用命令与未知指令仍保留真实受管进程和持久化。 */
export function publicationComponentSession(session: ManagedSession): ManagedSession {
  const component = commandComponentSession(session).execution;
  const execution = createManagedExecution(session.execution.cwd, session.slot.source.config, session.execution.signal, []);
  execution.run = session.execution.run.bind(session.execution);
  execution.git = args => readOnlyGit(args) ? component.git(args) : session.execution.git(args);
  execution.streamGit = (args, consume, exitCodes) => readOnlyGit(args)
    ? component.streamGit(args, consume, exitCodes) : session.execution.streamGit(args, consume, exitCodes);
  return { ...session, execution };
}
