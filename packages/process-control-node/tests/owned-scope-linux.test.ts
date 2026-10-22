import { expect, test } from 'vitest';
import * as provider from '../dist/index.js';

const supported = process.platform === 'linux' && process.arch === 'x64';
test('exports an explicit Linux owned scope factory', () => {
  expect(provider).toHaveProperty('createLinuxOwnedProcessScopeProvider', expect.any(Function));
});
test.runIf(supported)('requires real empty subreaper ownership for normal closure', async () => {
  const scope = provider.createLinuxOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', 'process.stdout.write("owned")'], environment: process.env,
    binding: 'linux-normal', startupTimeoutMs: 5000, terminationTimeoutMs: 5000 });
  try {
    const result = await provider.createPosixProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
    if (result.status !== 'FOUND') throw Error('fixture root missing');
    await scope.bind(result.identity); await scope.authorize();
    expect(await scope.completion).toMatchObject({ exitCode: 0, closure: { status: 'closed', reason: 'normal', empty: true } });
  } finally { await scope.dispose(); }
});
test.runIf(supported)('retains and terminates a fast setsid double-fork descendant', async () => {
  const detach = (body: string) => `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(body)}],{detached:true,stdio:'ignore'});c.unref()`;
  const scope = provider.createLinuxOwnedProcessScopeProvider().start({ command: process.execPath, args: ['-e', detach(detach('setInterval(()=>{},1000)'))], environment: process.env,
    binding: 'linux-descendant', startupTimeoutMs: 5000, terminationTimeoutMs: 5000 });
  try {
    const result = await provider.createPosixProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
    if (result.status !== 'FOUND') throw Error('fixture root missing');
    await scope.bind(result.identity); await scope.authorize();
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'descendants-remained', empty: true });
  } finally { await scope.dispose(); }
});
