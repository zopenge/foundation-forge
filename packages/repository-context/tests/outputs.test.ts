import { expect, test } from 'vitest';
import * as api from '../src/index.js';

test('serializes nested JSON with deterministic keys and a trailing newline', () => {
  expect(api.serializeRepositoryContextJson({ z: [{ b: 2, a: 1 }], A: true })).toBe("{\n  \"A\": true,\n  \"z\": [\n    {\n      \"a\": 1,\n      \"b\": 2\n    }\n  ]\n}\n");
  expect(() => api.serializeRepositoryContextJson({ bad: NaN })).toThrow();
});
test('separates missing, stale and unexpected and normalizes all newlines', () => {
  const expected = Object.freeze({ z: 'missing', a: "one\ntwo\n", b: 'expected', c: '' });
  const current = Object.freeze({ a: "one\rtwo\r\n", b: 'changed', c: null, extra: '' });
  expect(api.compareRepositoryContextOutputs({ expected, current })).toEqual({ ok: false, missing: ['c', 'z'], stale: ['b'], unexpected: ['extra'] });
  expect(api.compareRepositoryContextOutputs({ expected: { a: "x\n" }, current: { a: "x\r\n" } })).toEqual({ ok: true, missing: [], stale: [], unexpected: [] });
  expect(current.c).toBe(null);
});
