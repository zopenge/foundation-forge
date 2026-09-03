import { expect, test } from 'vitest';

import { selectTcpListeners } from '../src/index.js';

test('selects requested ports and returns deterministic unique listener identities', () => {
  const listeners = [
    { address: '::', port: 4000, process: { command: 'b', pid: 7, startToken: 'two' } },
    { address: '127.0.0.1', port: 3000, process: { command: 'a', pid: 5, startToken: 'one' } },
    { address: '127.0.0.1', port: 3000, process: { command: 'a', pid: 5, startToken: 'one' } },
  ];

  expect(selectTcpListeners(listeners, { ports: [4000, 3000] })).toEqual([
    { address: '127.0.0.1', port: 3000, process: { command: 'a', pid: 5, startToken: 'one' } },
    { address: '::', port: 4000, process: { command: 'b', pid: 7, startToken: 'two' } },
  ]);
});
