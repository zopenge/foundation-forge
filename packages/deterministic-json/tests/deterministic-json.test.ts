import { describe, expect, test } from 'vitest';

import {
  DeterministicJsonError,
  assertJsonValue,
  sortJsonValue,
  stringifyDeterministicJson,
} from '../src/index.js';

describe('deterministic JSON', () => {
  test('sorts object keys recursively while preserving array order and input values', () => {
    const input = { z: 1, a: [{ y: true, x: null }, 'last'] };

    expect(sortJsonValue(input)).toEqual({ a: [{ x: null, y: true }, 'last'], z: 1 });
    expect(Object.keys(input)).toEqual(['z', 'a']);
    expect(Object.keys(input.a[0] as object)).toEqual(['y', 'x']);
    expect(stringifyDeterministicJson(input)).toBe('{"a":[{"x":null,"y":true},"last"],"z":1}');
  });

  test('supports bounded indentation and an explicit trailing newline', () => {
    expect(stringifyDeterministicJson({ b: 2, a: 1 }, {
      space: 2,
      trailingNewline: true,
    })).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  test.each([
    ['undefined', { value: undefined }, 'INVALID_JSON_VALUE'],
    ['bigint', 1n, 'INVALID_JSON_VALUE'],
    ['function', { value: () => undefined }, 'INVALID_JSON_VALUE'],
    ['non-finite number', Number.NaN, 'NON_FINITE_NUMBER'],
    ['date', new Date(0), 'CUSTOM_PROTOTYPE'],
    ['sparse array', Array(1), 'SPARSE_ARRAY'],
  ])('rejects %s values', (_name, value, code) => {
    expect(() => stringifyDeterministicJson(value)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  test('rejects circular references without overflowing the stack', () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => assertJsonValue(value)).toThrowError(
      expect.objectContaining({ code: 'CIRCULAR_REFERENCE' }),
    );
  });

  test('rejects accessor and symbol properties instead of evaluating or dropping them', () => {
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    });
    const symbol = { visible: true };
    Object.defineProperty(symbol, Symbol('hidden'), { value: true });

    expect(() => sortJsonValue(accessor)).toThrowError(
      expect.objectContaining({ code: 'ACCESSOR_PROPERTY' }),
    );
    expect(() => sortJsonValue(symbol)).toThrowError(
      expect.objectContaining({ code: 'SYMBOL_KEY' }),
    );
  });

  test('uses a structured error contract', () => {
    try {
      stringifyDeterministicJson(undefined);
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DeterministicJsonError);
      expect(error).toMatchObject({
        code: 'INVALID_JSON_VALUE',
        path: '$',
      });
    }
  });
});
