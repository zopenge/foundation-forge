import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { validateReleaseConfig } from '../../dist/node.js';
import { createManagedExecution } from '../../dist/node/managed-execution.js';
import { freezeManagedSource } from '../../dist/node/source.js';
import { openManagedSlot } from '../../dist/node/managed-paths.js';
import { createManagedSession } from '../../dist/node/managed-process.js';

const [cwd, phase, stage] = process.argv.slice(2);
if (!cwd || !['before', 'after'].includes(phase) || !['closure', 'later'].includes(stage)) throw new Error('fixture arguments required');
const config = validateReleaseConfig(JSON.parse(await readFile(resolve(cwd, 'release.config.json'), 'utf8')));
const source = await freezeManagedSource(cwd, 'release.config.json', createManagedExecution(cwd, config, undefined, []));
const slot = await openManagedSlot(source, createManagedExecution(cwd, config, undefined, []));
await mkdir(slot.paths.checkoutRoot, { recursive: true });
await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
const session = await createManagedSession(slot, 'publish');
const write = slot.store.writeState.bind(slot.store);
const exitAtBoundary = async () => {
  await writeFile(resolve(slot.paths.checkoutRoot, 'crash-boundary'), `${phase}:${stage}`);
  // 自有 argv 已返回精确关闭证据；真实退出协调者，故意不执行终态重绑或锁收尾。
  process.exit(71);
};
slot.store.writeState = async (state, beforeCommit) => {
  const selected = !!state.processes.at(-1)?.terminalSha256 && (stage === 'closure' || state.stage === 'install');
  await write(state, async prepared => {
    await beforeCommit?.(prepared);
    if (selected && phase === 'before') await exitAtBoundary();
  });
  if (selected && phase === 'after') await exitAtBoundary();
};
await session.execution.run('once-only', { command: 'node', args: ['-e', 'require("node:fs").appendFileSync("executions","x")'] }, 'CHECK_FAILED');
session.state.stage = 'install'; await session.persist();
throw new Error('fixture did not reach crash boundary');
