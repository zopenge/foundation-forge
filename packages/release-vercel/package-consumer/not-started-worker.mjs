import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { resolve } from 'node:path';
import { mock } from 'node:test';
import process from 'node:process';

const cwd = process.argv[2], statePath = resolve(cwd, '.tmp/release-slot/state.json');
const controller = new globalThis.AbortController();
let cancelled = false;
const rename = async (from, to) => {
  await filesystem.rename(from, to);
  if (!cancelled && String(to) === statePath) {
    const state = JSON.parse(await filesystem.readFile(statePath, 'utf8'));
    if (state.processes.at(-1)?.name === 'package-manager-version' && state.processes.at(-1)?.status === 'intent') {
      cancelled = true; controller.abort();
    }
  }
};
// 只在真实 state rename 完成后触发公开 AbortSignal；原锁、文件、Git、runner 和原生关闭保持真实。
const exports = { ...Object.fromEntries(Object.entries(filesystem).filter(([key]) => key !== 'default')), rename };
mock.module('node:fs/promises', { namedExports: exports, defaultExport: exports });
const { runRelease } = await import('@openge/forge-release-vercel/node');
const report = await runRelease({ command: 'check', cwd, signal: controller.signal });
assert.equal(cancelled, true);
assert.equal(report.ok, false); assert.equal(report.error?.code, 'CANCELLED');
assert.equal(report.processes?.status, 'closed'); assert.equal(report.budget?.observationsComplete, true);
const state = JSON.parse(await filesystem.readFile(statePath, 'utf8')), command = state.processes.at(-1);
assert.equal(command.name, 'package-manager-version'); assert.equal(command.status, 'stopped');
assert.equal(command.observationComplete, true); assert.match(command.terminalSha256, /^[a-f0-9]{64}$/u);
assert.equal(command.notStarted?.schemaVersion, 1); assert.equal(command.notStarted?.reason, 'cancelled-before-runner');
assert.ok(command.notStarted.binding.startsWith(`${state.runId}:${command.id}:`));
for (const key of ['pid', 'identity', 'scope', 'closure']) assert.equal(command[key], undefined);
assert.deepEqual(command.descendants, []);
const terminal = JSON.parse(await filesystem.readFile(resolve(cwd, '.tmp/release-slot/terminal.json'), 'utf8'));
assert.equal(terminal.command.id, command.id); assert.deepEqual(terminal.command.notStarted, command.notStarted);
assert.equal(report.runId, state.runId);
process.stdout.write(JSON.stringify(report));
