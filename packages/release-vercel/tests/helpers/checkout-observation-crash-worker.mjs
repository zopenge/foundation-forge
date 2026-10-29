import filesystem from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { validateReleaseConfig } from '../../dist/node.js';
import { createManagedExecution } from '../../dist/node/managed-execution.js';
import { freezeManagedSource } from '../../dist/node/source.js';
import { openManagedSlot } from '../../dist/node/managed-paths.js';
import { createManagedSession } from '../../dist/node/managed-process.js';
import { assertCheckoutFrozen, prepareCheckout } from '../../dist/node/managed-checkout.js';

const [cwd, boundary] = process.argv.slice(2);
if (!cwd || !['after-query', 'proof-before', 'proof-after', 'state-before', 'state-after'].includes(boundary)) throw new Error('fixture boundary required');
const config = validateReleaseConfig(JSON.parse(await readFile(resolve(cwd, 'release.config.json'), 'utf8')));
const original = createManagedExecution(cwd, config, undefined, []);
const source = await freezeManagedSource(cwd, 'release.config.json', original);
const slot = await openManagedSlot(source, original);
await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
const session = await createManagedSession(slot, 'check');
const executionAt = path => createManagedExecution(path, config, undefined, []);
await prepareCheckout({ ...session, execution: executionAt(slot.paths.checkoutRoot), executionAt });
const stop = () => {
  const batch = session.state.processes.at(-1);
  if (batch?.kind !== 'checkout-observation') throw new Error('fixture batch missing');
  // 所有已启动子scope的原生关闭事实仅供父测试清理判断，不能替代产品批次证明。
  filesystem.writeFileSync(resolve(dirname(cwd), 'observation-crash.json'), JSON.stringify({
    boundary, paths: slot.paths, state: session.state, batch, coordinator: slot.coordinator,
  }));
  process.exit(71);
};
if (boundary === 'after-query') {
  const git = session.execution.git.bind(session.execution);
  session.execution.git = async args => {
    const output = await git(args);
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') stop();
    return output;
  };
} else {
  const rename = filesystem.promises.rename;
  filesystem.promises.rename = async (from, to) => {
    const batch = session.state.processes.at(-1);
    const selected = batch?.kind === 'checkout-observation' && (boundary.startsWith('proof-')
      ? to === resolve(slot.paths.slotRoot, 'terminal.json') : to === slot.paths.statePath && !!batch.terminalSha256);
    if (selected && boundary.endsWith('before')) stop();
    await rename(from, to);
    if (selected && boundary.endsWith('after')) stop();
  };
  syncBuiltinESMExports();
}
await mkdir(slot.paths.checkoutRoot, { recursive: true });
await assertCheckoutFrozen(session);
throw new Error('fixture did not reach real crash boundary');
