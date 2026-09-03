import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';

if (stringifyDeterministicJson({ b: 2, a: 1 }) !== '{"a":1,"b":2}') {
  throw new Error('deterministic JSON consumer smoke failed');
}
