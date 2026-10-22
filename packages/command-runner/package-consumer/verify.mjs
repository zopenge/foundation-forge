import assert from 'node:assert/strict';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { TextDecoder } from 'node:util';
import { spawnSync } from 'node:child_process';
import { CommandRunnerError, normalizeCommandSpec } from '@openge/forge-command-runner';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { createWindowsOwnedProcessScopeProvider, createLinuxOwnedProcessScopeProvider, createWindowsProcessIdentityReader, createPosixProcessIdentityReader } from '@openge/forge-process-control-node';

assert.throws(() => normalizeCommandSpec({ command: '' }), CommandRunnerError);
assert.equal(Object.isFrozen(normalizeCommandSpec({ command: 'fixture', args: ['a'] }).args), true);
const tracked = new Map();
let terminations = 0;
const provider = {
  async listProcesses(request) {
    return request.pids.map(pid => {
      const identity = { pid, startToken: 'fixture-' + String(pid) };
      tracked.set(pid, identity);
      return identity;
    });
  },
  async listTcpListeners() { return []; },
  async terminateProcess() { throw new Error('unexpected single-process operation'); },
  async terminateProcessTree(request) {
    assert.deepEqual(request.process, tracked.get(request.process.pid));
    terminations += 1;
    process.kill(request.process.pid, 'SIGKILL');
    return { pid: request.process.pid, forced: true };
  },
};
const runner = createNodeCommandRunner({
  platform: 'posix', processControl: provider, terminationPolicy: { mode: 'force' },
  identityAcquisition: { timeoutMs: 1000, pollIntervalMs: 10 }, terminationTimeoutMs: 1000,
});
const fixture = fileURLToPath(new URL('./command-fixture.mjs', import.meta.url));
const spec = (mode, args = []) => ({ command: process.execPath, args: [fixture, mode, ...args], environment: { mode: 'inherit' }, output: { mode: 'capture', maxBytesPerStream: 100, overflow: 'fail' } });
const output = await runner.run(spec('output', ['7']));
assert.equal(output.exitCode, 7);
assert.equal(output.terminationReason, 'exit');
assert.equal(new TextDecoder().decode(output.stdout), 'alpha β');
assert.equal(new TextDecoder().decode(output.stderr), 'error');
const timed = await runner.run({ ...spec('wait'), timeoutMs: 80 });
assert.equal(timed.terminationReason, 'timeout');
assert.equal(terminations, 1);
assert.ok(timed.identity);

const browserRoot = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '-e', "await import('@openge/forge-command-runner');"], { encoding: 'utf8', windowsHide: true });
assert.equal(browserRoot.status, 0, browserRoot.stderr);
const browserNode = spawnSync(process.execPath, ['--conditions=browser', '--input-type=module', '-e', "try { await import('@openge/forge-command-runner/node'); process.exitCode = 1; } catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }"], { encoding: 'utf8', windowsHide: true });
assert.equal(browserNode.status, 0, browserNode.stderr);

// 真实安装制品装配的第二类消费者；不使用工作区源码、私有 helper 路径或假身份。
if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') throw Error('owned consumer requires an admitted host');
const windows = process.platform === 'win32';
const reader = windows ? createWindowsProcessIdentityReader() : createPosixProcessIdentityReader();
const scoped = createNodeCommandRunner({ platform: windows ? 'win32' : 'posix',
  ownedScopeProvider: windows ? createWindowsOwnedProcessScopeProvider() : createLinuxOwnedProcessScopeProvider(),
  processControl: { ...provider, listProcesses: async request => {
    const result = await reader.readIdentity({ pid: request.pids[0], signal: request.signal });
    return result.status === 'FOUND' ? [result.identity] : [];
  }, terminateProcessTree: async () => { throw Error('owned cleanup must not use the ordinary process provider'); } },
  terminationPolicy: { mode: 'force' }, identityAcquisition: { timeoutMs: 10000, pollIntervalMs: 20 }, terminationTimeoutMs: 5000 });
let scopeReady = false;
const manual = scoped.start({ command: process.execPath, args: ['-e', 'process.stdout.write("owned")'],
  ownedScope: { start: 'manual', binding: 'installed-manual' }, timeoutMs: 15000,
  output: { mode: 'capture', maxBytesPerStream: 100, overflow: 'fail' } }, event => { if (event.type === 'scope-ready') scopeReady = true; });
await manual.identity; assert.equal(scopeReady, true); assert.equal(typeof manual.authorizeStart, 'function');
await manual.authorizeStart(); const normal = await manual.result;
assert.equal(normal.ownedScope?.status, 'closed'); assert.equal(normal.terminationReason, 'exit');
assert.equal(new TextDecoder().decode(normal.stdout), 'owned');
const detach = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref()";
const background = await scoped.run({ command: process.execPath, args: ['-e', detach], ownedScope: { start: 'automatic', binding: 'installed-descendant' }, timeoutMs: 15000 });
assert.equal(background.terminationReason, 'termination-failure');
assert.equal(background.ownedScope?.reason, 'descendants-remained'); assert.equal(background.ownedScope?.empty, true);
