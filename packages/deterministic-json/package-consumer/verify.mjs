import assert from 'node:assert/strict';

import { cloneJsonValue, stringifyDeterministicJson } from '@openge/forge-deterministic-json';

if (stringifyDeterministicJson({ b: 2, a: 1 }) !== '{"a":1,"b":2}') {
  throw new Error('deterministic JSON consumer smoke failed');
}

const first = { y: 2, a: 1 };
const input = { z: [first], a: 'original' };
const snapshot = cloneJsonValue(input);
assert.equal(JSON.stringify(snapshot), '{"z":[{"y":2,"a":1}],"a":"original"}');
first.y = 9;
input.a = 'changed';
assert.deepEqual(snapshot, { z: [{ y: 2, a: 1 }], a: 'original' });

const prototypeJson = '{"z":1,"__proto__":{"payload":true},"a":2}';
const prototypeSnapshot = cloneJsonValue(JSON.parse(prototypeJson));
assert.equal(JSON.stringify(prototypeSnapshot), prototypeJson);
assert.equal(Object.getPrototypeOf(prototypeSnapshot), Object.prototype);
assert.equal(Object.hasOwn(prototypeSnapshot, '__proto__'), true);
