import process from 'node:process';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../src/index.js';
import { command, decode, makeRunner } from './helpers.js';

describe('node command execution', () => {
  it.each([0, 7])('reports exit code %i and ordered separate byte streams', async code => {
    const events: CommandEvent[] = [];
    const { runner } = makeRunner();
    const result = await runner.run(command('output', [String(code)], { output: { mode: 'capture', maxBytesPerStream: 100, overflow: 'truncate' } }), event => events.push(event));
    expect(result.exitCode).toBe(code);
    expect(result.terminationReason).toBe('exit');
    expect(decode(result.stdout)).toBe('alpha β');
    expect(decode(result.stderr)).toBe('error');
    expect(events[0]?.type).toBe('spawned');
    expect(events.at(-1)?.type).toBe('exited');
    expect(events.filter(e => e.type === 'stdout').map(e => decode(e.chunk)).join('')).toBe('alpha β');
    expect(events.findIndex(e => e.type === 'identified')).toBeGreaterThan(0);
  });

  it('passes cwd, arguments, inherited overrides and removals without a shell', async () => {
    const { runner } = makeRunner();
    process.env.FORGE_COMMAND_REMOVE = 'remove';
    try {
      const args = ['space here', '"quotes"', '中文', '$HOME; exit 9'];
      const result = await runner.run(command('inspect', args, {
        cwd: process.cwd(), environment: { mode: 'inherit', values: { FORGE_COMMAND_VALUE: 'override', FORGE_COMMAND_REMOVE: undefined } },
        output: { mode: 'capture', maxBytesPerStream: 100_000, overflow: 'fail' },
      }));
      const parsed = JSON.parse(decode(result.stdout)) as { args: string[]; cwd: string; env: Record<string, string> };
      expect(parsed.args).toEqual(args);
      expect(parsed.cwd).toBe(process.cwd());
      expect(parsed.env.FORGE_COMMAND_VALUE).toBe('override');
      expect(parsed.env.FORGE_COMMAND_REMOVE).toBeUndefined();
    } finally { delete process.env.FORGE_COMMAND_REMOVE; }
  });

  it('replaces the environment without inheriting parent values', async () => {
    process.env.FORGE_COMMAND_PARENT = 'secret';
    try {
      const result = await makeRunner().runner.run(command('inspect', [], {
        environment: { mode: 'replace', values: { ONLY_VALUE: 'yes' } },
        output: { mode: 'capture', maxBytesPerStream: 100_000, overflow: 'fail' },
      }));
      const parsed = JSON.parse(decode(result.stdout)) as { env: Record<string, string> };
      expect(parsed.env.ONLY_VALUE).toBe('yes');
      expect(parsed.env.FORGE_COMMAND_PARENT).toBeUndefined();
    } finally { delete process.env.FORGE_COMMAND_PARENT; }
  });

  it('does not capture the default event stream and suppresses ignored streams', async () => {
    const { runner } = makeRunner();
    const events: CommandEvent[] = [];
    const result = await runner.run(command('output'), event => events.push(event));
    expect(result.stdout).toBeUndefined();
    expect(events.some(e => e.type === 'stdout')).toBe(true);
    events.length = 0;
    const ignored = await runner.run(command('output', [], { output: { mode: 'ignore' } }), event => events.push(event));
    expect(ignored.stdout).toBeUndefined();
    expect(events.some(e => e.type === 'stdout' || e.type === 'stderr')).toBe(false);
  });

  it('turns observer exceptions into bounded diagnostics including the exited observer', async () => {
    const result = await makeRunner().runner.run(command('output'), () => { throw new Error('observer'); });
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics.filter(d => d.code === 'COMMAND_OBSERVER_FAILED')).toHaveLength(1);
    const exitedFailure = await makeRunner().runner.run(command('output'), event => {
      if (event.type === 'exited') throw new Error('final observer');
    });
    expect(exitedFailure.diagnostics).toEqual([expect.objectContaining({ code: 'COMMAND_OBSERVER_FAILED' })]);
  });

  it('settles all handles on spawn failure without an unhandled rejection', async () => {
    const running = makeRunner().runner.start({ command: 'forge-command-missing-executable-9d3be' });
    await expect(running.pid).rejects.toMatchObject({ code: 'COMMAND_START_FAILED' });
    expect(await running.identity).toBeNull();
    expect(await running.result).toMatchObject({ terminationReason: 'start-failure', diagnostics: [expect.objectContaining({ code: 'COMMAND_START_FAILED' })] });
  });
});
