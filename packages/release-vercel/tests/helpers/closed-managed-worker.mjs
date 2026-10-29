import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { validateReleaseConfig } from '../../dist/node.js';
import { createManagedExecution } from '../../dist/node/managed-execution.js';
import { freezeManagedSource } from '../../dist/node/source.js';
import { openManagedSlot } from '../../dist/node/managed-paths.js';
import { createManagedSession } from '../../dist/node/managed-process.js';

const [cwd, mode] = process.argv.slice(2);
if (!cwd) throw new Error('fixture cwd required');
const config = validateReleaseConfig(JSON.parse(await readFile(resolve(cwd, 'release.config.json'), 'utf8')));
const source = await freezeManagedSource(cwd, 'release.config.json', createManagedExecution(cwd, config, undefined, []));
const slot = await openManagedSlot(source, createManagedExecution(cwd, config, undefined, []));
await mkdir(slot.paths.checkoutRoot, { recursive: true });
await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
const session = await createManagedSession(slot, 'publish');
if (mode === 'cancelled') {
  const controller = new globalThis.AbortController();
  try {
    await session.execution.run('fixture-cancelled-command', { command: 'node', args: ['-e', 'process.stdout.write("ready");setInterval(()=>{},100)'] },
      'CHECK_FAILED', undefined, controller.signal, true, text => { if (text.includes('ready')) controller.abort(); });
    throw new Error('expected cancellation');
  } catch (error) { if (error?.code !== 'CANCELLED') throw error; }
  await session.assertStopped();
} else {
  await session.execution.run('fixture-closed-command', { command: 'node', args: ['-e', 'process.stdout.write("closed")'] }, 'CHECK_FAILED');
  await session.assertClosed();
}
session.state.stage = 'install'; await session.persist();
// 真实作业已见证关闭；模拟协调者在整体状态关闭/释放旧锁之前退出。
process.stdout.write('closed journal saved');
