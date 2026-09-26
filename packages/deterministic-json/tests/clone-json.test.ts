import { describe, expect, it, vi } from 'vitest';

import { cloneJsonValue } from '../src/index.js';

describe('strict JSON snapshots', () => {
  it('preserves nested key and array order in an independent snapshot', () => {
    const first = { y: 2, a: 1 };
    const input = { z: [first, { last: true }], a: 'original' };
    const snapshot = cloneJsonValue(input);
    const original = JSON.stringify(input);

    expect(JSON.stringify(snapshot)).toBe(original);
    first.y = 9;
    input.z.reverse();
    input.a = 'changed';
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  it('copies shared non-cyclic values and null-prototype records as ordinary JSON data', () => {
    const shared = { value: 'original' };
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: shared,
      a: shared,
    });
    const snapshot = cloneJsonValue(input);

    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(JSON.stringify(snapshot)).toBe('{"z":{"value":"original"},"a":{"value":"original"}}');
    shared.value = 'changed';
    expect(snapshot).toEqual({ z: { value: 'original' }, a: { value: 'original' } });
  });

  it.each([null, true, 'value', 12])('preserves the primitive %j', (input) => {
    expect(cloneJsonValue(input)).toBe(input);
  });

  it.each([
    ['undefined', undefined, 'INVALID_JSON_VALUE'],
    ['bigint', 1n, 'INVALID_JSON_VALUE'],
    ['non-finite', Number.NaN, 'NON_FINITE_NUMBER'],
    ['custom prototype', new Date(0), 'CUSTOM_PROTOTYPE'],
    ['sparse array', new Array(1), 'SPARSE_ARRAY'],
    ['array property', Object.assign([], { extra: true }), 'INVALID_JSON_VALUE'],
    ['symbol key', { [Symbol('hidden')]: 1 }, 'SYMBOL_KEY'],
    ['non-enumerable', Object.defineProperty({}, 'hidden', { value: 1 }), 'INVALID_JSON_VALUE'],
  ])('rejects %s without silently changing its value', (_name, input, code) => {
    expect(() => cloneJsonValue(input)).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects accessors and toJSON without invoking caller code', () => {
    const caller = vi.fn(() => 'caller');
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: caller });

    expect(() => cloneJsonValue(accessor)).toThrowError(
      expect.objectContaining({ code: 'ACCESSOR_PROPERTY', path: '$["value"]' }),
    );
    expect(() => cloneJsonValue({ toJSON: caller })).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON_VALUE', path: '$["toJSON"]' }),
    );
    expect(caller).not.toHaveBeenCalled();
  });

  it('rejects a cycle and retains its structured error path', () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    expect(() => cloneJsonValue(input)).toThrowError(
      expect.objectContaining({ code: 'CIRCULAR_REFERENCE', path: '$["self"]' }),
    );
  });

  it('preserves an own prototype-named property without changing the snapshot prototype', () => {
    const json = '{"z":1,"__proto__":{"payload":true},"a":2}';
    const snapshot = cloneJsonValue(JSON.parse(json));

    expect(JSON.stringify(snapshot)).toBe(json);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
  });
});
