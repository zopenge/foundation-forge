import { expect, test } from 'vitest';
import { createTextIndex, rankTextIndex, textPostings } from '../src/investigation/text-index.js';
import { sourceRef } from './repository-fixtures.js';

test('builds deterministic postings and ranks matching body text', () => {
  const index = createTextIndex([
    { source: sourceRef('src/retry.ts', 1, 2), path: 'src/retry.ts', text: '// 超时重试\nexport const retry = true;' },
    { source: sourceRef('src/other.ts', 1, 2), path: 'src/other.ts', text: 'export const stable = true;' },
  ]);
  expect(textPostings(index, '超时')).toEqual([{ path: 'src/retry.ts', line: 1 }]);
  expect(rankTextIndex(index, ['超时', '重试'])[0]?.path).toBe('src/retry.ts');
});