import { describe, expect, it } from 'vitest';
import { CommandRunnerError, normalizeCommandSpec, type CommandEvent, type CommandSpec } from '../src/index.js';

describe('command specification', () => {
  it.each([
    [{ command: '' }, 'COMMAND_INVALID_SPEC'],
    [{ command: '  ' }, 'COMMAND_INVALID_SPEC'],
    [{ command: 'a\0b' }, 'COMMAND_INVALID_SPEC'],
    [{ command: 'x', args: ['a\0b'] }, 'COMMAND_INVALID_SPEC'],
    [{ command: 'x', cwd: '' }, 'COMMAND_INVALID_SPEC'],
    [{ command: 'x', timeoutMs: 0 }, 'COMMAND_INVALID_TIMEOUT'],
    [{ command: 'x', timeoutMs: Infinity }, 'COMMAND_INVALID_TIMEOUT'],
    [{ command: 'x', timeoutMs: 1.5 }, 'COMMAND_INVALID_TIMEOUT'],
    [{ command: 'x', heartbeatMs: -1 }, 'COMMAND_INVALID_HEARTBEAT'],
    [{ command: 'x', output: { mode: 'capture', maxBytesPerStream: 0, overflow: 'truncate' } }, 'COMMAND_INVALID_CAPTURE_LIMIT'],
    [{ command: 'x', output: { mode: 'capture', maxBytesPerStream: 1.5, overflow: 'fail' } }, 'COMMAND_INVALID_CAPTURE_LIMIT'],
  ] satisfies [CommandSpec, string][])('rejects invalid input %# synchronously', (spec, code) => {
    expect(() => normalizeCommandSpec(spec)).toThrowError(expect.objectContaining({ code }));
  });

  it('snapshots and freezes mutable command inputs', () => {
    const args = ['a b'];
    const values = { FOO: 'before' };
    const input: CommandSpec = { command: 'x', args, environment: { mode: 'inherit', values } };
    const normalized = normalizeCommandSpec(input);
    args[0] = 'after';
    values.FOO = 'after';
    expect(normalized.args).toEqual(['a b']);
    expect(normalized.environment).toEqual({ mode: 'inherit', values: { FOO: 'before' } });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.args)).toBe(true);
    expect(Object.isFrozen(normalized.environment?.values)).toBe(true);
    expect(normalized.output).toEqual({ mode: 'events' });
  });

  it('defaults an omitted environment to inheritance', () => {
    expect(normalizeCommandSpec({ command: 'x' }).environment).toEqual({ mode: 'inherit' });
  });

  it('exports event and structured error contracts from the root', () => {
    const event: CommandEvent = { type: 'stdout', chunk: new Uint8Array([97]) };
    expect(event.chunk[0]).toBe(97);
    expect(new CommandRunnerError('COMMAND_START_FAILED', { field: 'command' }).code).toBe('COMMAND_START_FAILED');
  });
});
