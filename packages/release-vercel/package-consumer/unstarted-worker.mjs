import assert from 'node:assert/strict';
import * as processes from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mock } from 'node:test';
import process from 'node:process';

const cwd = process.argv[2];
let corrupted = false, starts = 0, helpers = 0;
const spawn = (command, args, options) => {
  const child = processes.spawn(command, args, options);
  if (args?.[0]?.endsWith('/scope-host.js') || args?.[0]?.endsWith('\\scope-host.js')) {
    helpers++;
    const on = child.on, send = child.send;
    child.send = function (message, ...rest) { if (message?.type === 'start') starts++; return send.call(this, message, ...rest); };
    child.on = function (event, listener) {
      if (event !== 'message') return on.call(this, event, listener);
      return on.call(this, event, function (value, ...rest) {
        // 仅破坏首条控制消息，真实helper/Job的终止、关闭及空集合观察仍由已安装包负责。
        if (!corrupted) { corrupted = true; return listener.call(this, { malformed: true }, ...rest); }
        return listener.call(this, value, ...rest);
      });
    };
  }
  return child;
};
const exports = { ...Object.fromEntries(Object.entries(processes).filter(([key]) => key !== 'default')), spawn };
mock.module('node:child_process', { namedExports: exports, defaultExport: exports });
const { runRelease } = await import('@openge/forge-release-vercel/node');
const report = await runRelease({ command: 'check', cwd });
assert.equal(corrupted, true); assert.equal(helpers, 1); assert.equal(starts, 0);
assert.equal(report.ok, false); assert.equal(report.error?.code, 'PROCESS_STATE_UNKNOWN');
const state = JSON.parse(await readFile(resolve(cwd, 'state/release-slot/state.json'), 'utf8'));
assert.equal(state.processes.length, 1);
const command = state.processes[0];
assert.equal(command.name, 'git'); assert.equal(command.status, 'unknown');
for (const key of ['pid', 'identity', 'scope']) assert.equal(command[key], undefined);
assert.equal(command.closure?.ownedScope?.rootIdentity, undefined);
assert.equal(command.closure?.ownedScope?.reason, 'provider-failed');
assert.equal(command.closure?.ownedScope?.empty, true);
assert.equal(report.runId, state.runId);
process.stdout.write(JSON.stringify(report));
