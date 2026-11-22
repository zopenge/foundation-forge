import { describe, expect, it } from 'vitest';
import { isPositiveAtomicAmount } from '../src/index.js';

describe('isPositiveAtomicAmount', () => {
  it.each(['1', '90071992547409931234567890123'])('accepts %s without number conversion', value => {
    expect(isPositiveAtomicAmount(value)).toBe(true);
  });

  it.each(['', '0', '01', '-1', '+1', '1.0', '1e18', '1\n', ' 1', 1, undefined])('rejects %s', value => {
    expect(isPositiveAtomicAmount(value)).toBe(false);
  });
});
