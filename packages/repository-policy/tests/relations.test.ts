import { describe, expect, it } from 'vitest';

import { stableTopologicalOrder } from '../src/relations.js';

describe('stableTopologicalOrder', () => {
  it('orders dependencies before dependants and sorts peers by code point', () => {
    const ids = new Set(['d', 'c', 'b', 'a']);
    const requires = new Map<string, readonly string[]>([
      ['d', ['c', 'b']],
      ['c', ['a']],
      ['b', ['a']],
      ['a', []],
    ]);

    expect(stableTopologicalOrder(ids, requires)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('orders only the requested subset while respecting in-subset dependencies', () => {
    const ids = new Set(['b', 'd']);
    const requires = new Map<string, readonly string[]>([
      ['d', ['c', 'b']],
      ['c', ['a']],
      ['b', ['a']],
      ['a', []],
    ]);

    expect(stableTopologicalOrder(ids, requires)).toEqual(['b', 'd']);
  });

  it('does not depend on Set or requires insertion order', () => {
    const first = stableTopologicalOrder(
      new Set(['z', 'a', 'm']),
      new Map([
        ['z', ['a']],
        ['m', []],
        ['a', []],
      ]),
    );
    const second = stableTopologicalOrder(
      new Set(['m', 'z', 'a']),
      new Map([
        ['a', []],
        ['m', []],
        ['z', ['a']],
      ]),
    );

    expect(first).toEqual(['a', 'm', 'z']);
    expect(second).toEqual(first);
  });

  it('throws on a cycle because manifest validation should prevent one', () => {
    const ids = new Set(['a', 'b']);
    const requires = new Map<string, readonly string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);

    expect(() => stableTopologicalOrder(ids, requires)).toThrow('cycle');
  });
});
