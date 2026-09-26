import { describe, expect, test } from 'vitest';

import { sortJsonValue, stringifyDeterministicJson } from '../src/index.js';

describe('JSON prototype property preservation', () => {
  test.each([
    '{"__proto__":{"payload":true},"ok":1}',
    '{"__proto__":null,"ok":1}',
    '{"__proto__":12,"ok":1}',
  ])('preserves the own data property in %s without changing the clone prototype', (json) => {
    const input: unknown = JSON.parse(json);
    const snapshot = sortJsonValue(input);

    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.hasOwn(snapshot as object, '__proto__')).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(json);
    expect(stringifyDeterministicJson(input)).toBe(json);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  });

  test('preserves nested prototype-named keys inside array elements', () => {
    const json = '{"list":[{"__proto__":{"constructor":"kept"},"a":1}]}';
    const input: unknown = JSON.parse(json);

    expect(stringifyDeterministicJson(input)).toBe(json);
    expect(sortJsonValue(input)).toEqual(input);
  });
});
