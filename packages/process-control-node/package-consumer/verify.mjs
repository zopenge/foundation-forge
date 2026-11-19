import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { log } from 'node:console';
import process from 'node:process';
import { mkdir, mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acquireLocalDirectoryLease, createWindowsNativeProcessIdentityReader, createWindowsProcessControl } from '@openge/forge-process-control-node';

// 独立SDK消费者：以外部Core reader复核身份，更新后的身份不能复用首次授权。
let token = '/Date(123)/', reads = 0;
const requests = [];
const provider = createWindowsProcessControl({ listenerBackend: 'netstat',
  identityReader: { readIdentity: async ({ pid }) => { reads++; return { status: 'FOUND', identity: { pid, startToken: token } }; } },
  runner: async request => {
    assert.equal(request.command, 'taskkill.exe'); requests.push(request.args);
    return { exitCode: 0, stdout: '', stderr: '' };
  } });
const identity = { pid: 42, startToken: token };
assert.deepEqual(await provider.terminateProcess({ process: identity, policy: { mode: 'force' } }), { pid: 42, forced: true });
token = '/Date(124)/';
await assert.rejects(provider.terminateProcessTree({ process: identity, policy: { mode: 'force' } }), { code: 'PROCESS_IDENTITY_CHANGED' });
assert.equal(reads, 2); assert.deepEqual(requests, [['/PID', '42', '/F']]);

if (process.platform === 'win32' && process.arch === 'x64') {
  // 原生消费者只访问亲自创建的child；所有路径均等待真实close。
  const signal = globalThis.AbortSignal.timeout(5000), reader = createWindowsNativeProcessIdentityReader();
  const own = await reader.readIdentity({ pid: process.pid, signal }); assert.equal(own.status, 'FOUND');
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'],
    { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  let childError;
  child.on('error', error => { childError = error; });
  const closed = new Promise(resolve => { child.once('close', resolve); });
  try {
    await once(child, 'spawn');
    const observed = await reader.readIdentity({ pid: child.pid, signal }); assert.equal(observed.status, 'FOUND');
    const native = createWindowsProcessControl({ listenerBackend: 'netstat', identityReader: reader });
    assert.deepEqual(await native.terminateProcessTree({ process: observed.identity, policy: { mode: 'force' }, signal }),
      { pid: child.pid, forced: true });
    await closed; assert.equal(childError, undefined);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}
log('Process-control Node tarball consumer verified explicit identity composition and fresh termination.');

if (process.arch === 'x64' && ['win32', 'linux'].includes(process.platform)) {
  const base = resolve('tmp'); await mkdir(base, { recursive: true });
  const directory = await realpath(await mkdtemp(resolve(base, 'lease-')));
  try {
    const options = { scope: { namespace: 'FoundationForge.ConsumerLease' } };
    const lease = await acquireLocalDirectoryLease(directory, options);
    try {
      await lease.assertOwned();
      await assert.rejects(acquireLocalDirectoryLease(directory, options), { code: 'LOCKED' });
    } finally { await lease.release(); }
    await (await acquireLocalDirectoryLease(directory, { ...options, expectedIdentity: lease.identity })).release();
  } finally { await rmdir(directory); }
  log('Process-control Node tarball consumer verified the public local directory lease.');
}
