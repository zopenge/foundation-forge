import { describe, expect, test } from 'vitest';

import { runPeerNetworkOperation } from '../src/index.js';

describe('peer network operation timeout', () => {
  test('maps an elapsed timeout to a structured error code', async () => {
    const operation = runPeerNetworkOperation({
      operation: (signal) => new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      timeoutCode: 'connect-timeout',
      timeoutMs: 1,
    });

    await expect(operation).rejects.toMatchObject({
      code: 'connect-timeout',
      details: { timeoutMs: 1 },
    });
  });

  test('preserves caller cancellation instead of reporting a timeout', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(runPeerNetworkOperation({
      operation: async (signal) => {
        signal.throwIfAborted();
      },
      signal: controller.signal,
      timeoutCode: 'connect-timeout',
      timeoutMs: 10,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an invalid timeout value: %s',
    async (timeoutMs) => {
      await expect(runPeerNetworkOperation({
        operation: async () => undefined,
        timeoutCode: 'connect-timeout',
        timeoutMs,
      })).rejects.toThrow('timeoutMs must be a non-negative finite number');
    },
  );

  test('rejects a timeout exceeding the setTimeout limit', async () => {
    await expect(runPeerNetworkOperation({
      operation: async () => undefined,
      timeoutCode: 'connect-timeout',
      timeoutMs: 2_147_483_648,
    })).rejects.toThrow('timeoutMs must not exceed 2147483647');
  });
});
