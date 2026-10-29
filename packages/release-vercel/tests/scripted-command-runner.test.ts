import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { CommandEvent, CommandSpec } from '@openge/forge-command-runner';
import { createScriptedCommandRunner } from './helpers/scripted-command-runner.js';

const cwd = resolve(import.meta.dirname, 'scripted-runner-component');
const call = { command: 'git', args: ['rev-parse', 'HEAD'], cwd, stdout: 'synthetic-output\n', exitCode: 7 };
const spec = (): CommandSpec => ({ command: call.command, args: [...call.args], cwd, timeoutMs: 1000,
  ownedScope: { start: 'manual', binding: 'scripted-component-binding' },
  output: { mode: 'capture', maxBytesPerStream: 4096, overflow: 'fail' } });

it('未知、乱序或缺少manual scope的调用不能消费脚本，直接run永远拒绝', async () => {
  const f = createScriptedCommandRunner({ calls: [call] });
  expect(() => f.runner.start({ ...spec(), ownedScope: { start: 'automatic', binding: 'automatic-forbidden' } })).toThrow('SCRIPTED_MANUAL_SCOPE_REQUIRED');
  const { ownedScope: omitted, ...withoutScope } = spec();
  expect(omitted).toBeDefined(); expect(() => f.runner.start(withoutScope)).toThrow('SCRIPTED_MANUAL_SCOPE_REQUIRED');
  for (const mismatch of [{ command: process.execPath }, { args: ['push', 'origin', 'HEAD:main'] }, { cwd: resolve(cwd, 'other') }])
    expect(() => f.runner.start({ ...spec(), ...mismatch })).toThrow('SCRIPTED_COMMAND_ORDER');
  await expect(f.runner.run(spec())).rejects.toThrow('SCRIPTED_DIRECT_RUN_FORBIDDEN');
  expect(f.observed).toHaveLength(0); expect(() => f.assertConsumed()).toThrow('SCRIPTED_UNCONSUMED_COMMANDS');
  const running = f.runner.start(spec()); await running.authorizeStart?.(); await running.result; f.assertConsumed();
  expect(() => f.runner.start(spec())).toThrow('SCRIPTED_UNEXPECTED_COMMAND');
  const empty = createScriptedCommandRunner({ calls: [] });
  expect(() => empty.runner.start(spec())).toThrow('SCRIPTED_UNEXPECTED_COMMAND'); empty.assertConsumed();
});

it('start异步报告合成控制身份，授权前既无stdout也无结果，非零退出仍为exit', async () => {
  const f = createScriptedCommandRunner({ calls: [call] }), events: CommandEvent[] = [];
  const running = f.runner.start(spec(), event => { events.push(event); });
  let settled = false; const result = running.result.then(value => { settled = true; return value; });
  expect(events).toEqual([]); await running.identity; await Promise.resolve();
  expect(events.map(event => event.type)).toEqual(['spawned', 'identified', 'scope-ready']); expect(settled).toBe(false);
  expect(() => f.assertConsumed()).toThrow('SCRIPTED_ACTIVE_COMMANDS');
  const ready = events.find(event => event.type === 'scope-ready'); if (ready?.type !== 'scope-ready') throw new Error('missing synthetic readiness');
  expect(ready.binding).toBe('scripted-component-binding'); expect(ready.identity.startToken).toContain('scripted:protocol-only:');
  expect(ready.identity.pid).toBeGreaterThan(4_294_967_295); expect(await running.pid).toBe(ready.identity.pid);
  expect(running.authorizeStart).toBeTypeOf('function'); await running.authorizeStart?.();
  const completed = await result;
  expect(completed).toMatchObject({ exitCode: 7, terminationReason: 'exit', identity: ready.identity,
    ownedScope: { scopeId: ready.scopeId, binding: ready.binding, status: 'closed', reason: 'normal', empty: true, rootIdentity: ready.identity } });
  expect(new TextDecoder().decode(completed.stdout)).toBe(call.stdout);
  expect(events.map(event => event.type)).toEqual(['spawned', 'identified', 'scope-ready', 'stdout', 'exited']);
  expect(f.evidence).toBe('synthetic-protocol-only'); f.assertConsumed();
});

it('scope-ready内取消保留已提供身份和合成stopped结果，绝不输出未授权payload', async () => {
  const controller = new AbortController(), f = createScriptedCommandRunner({ calls: [call] }), events: CommandEvent[] = [];
  const running = f.runner.start({ ...spec(), signal: controller.signal }, event => {
    events.push(event); if (event.type === 'scope-ready') controller.abort();
  });
  const result = await running.result, ready = events.find(event => event.type === 'scope-ready');
  if (ready?.type !== 'scope-ready') throw new Error('missing synthetic readiness');
  expect(result).toMatchObject({ exitCode: null, terminationReason: 'abort', identity: ready.identity,
    ownedScope: { scopeId: ready.scopeId, binding: ready.binding, rootIdentity: ready.identity, status: 'unknown', reason: 'terminated', empty: true } });
  expect(events.map(event => event.type)).toEqual(['spawned', 'identified', 'scope-ready', 'termination-requested', 'exited']);
  expect(events.find(event => event.type === 'termination-requested')).toEqual({ type: 'termination-requested', reason: 'abort' });
  expect(result.stdout).toHaveLength(0); await expect(running.authorizeStart?.()).rejects.toThrow('SCRIPTED_INACTIVE_SCOPE');
  await running.terminate(); expect(events.filter(event => event.type === 'exited')).toHaveLength(1); f.assertConsumed();
});

it('显式timeout终止只产生一次合成停止，事件模式不伪造capture输出', async () => {
  const f = createScriptedCommandRunner({ calls: [call] }), events: CommandEvent[] = [];
  const running = f.runner.start({ ...spec(), output: { mode: 'events' } }, event => { events.push(event); });
  await running.identity; await running.terminate('timeout'); await running.terminate('abort');
  const result = await running.result;
  expect(result).toMatchObject({ terminationReason: 'timeout', exitCode: null, ownedScope: { status: 'unknown', reason: 'terminated', empty: true } });
  expect(result.stdout).toBeUndefined(); expect(events.filter(event => event.type === 'stdout')).toEqual([]);
  expect(events.filter(event => event.type === 'termination-requested')).toEqual([{ type: 'termination-requested', reason: 'timeout' }]);
  expect(events.filter(event => event.type === 'exited')).toHaveLength(1); f.assertConsumed();
});
