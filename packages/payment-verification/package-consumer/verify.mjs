import assert from 'node:assert/strict';
import { isPositiveAtomicAmount } from '@openge/forge-payment-verification';

assert.equal(isPositiveAtomicAmount('9007199254740993123456789'), true);
assert.equal(isPositiveAtomicAmount('0'), false);
assert.equal(isPositiveAtomicAmount('1e18'), false);
