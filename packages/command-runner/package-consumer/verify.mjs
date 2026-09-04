import assert from 'node:assert/strict';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { TextDecoder } from 'node:util';
import { spawnSync } from 'node:child_process';
import { CommandRunnerError, normalizeCommandSpec } from '@openge/forge-command-runner';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';

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
