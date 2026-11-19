import { expect, it } from 'vitest';
import { readRetirementHost, validRetirementHost } from '../src/node/retirement-host.js';

it('requires a recognized platform and a hashed machine identity', () => {
  expect(validRetirementHost({ platform: 'win32', hostId: 'a'.repeat(64) })).toBe(true);
  expect(validRetirementHost({ platform: 'linux', hostId: 'a'.repeat(64) })).toBe(true);
  expect(validRetirementHost({ platform: 'darwin', hostId: 'a'.repeat(64) })).toBe(false);
  expect(validRetirementHost({ platform: 'win32', hostId: 'raw-identifier' })).toBe(false);
});
it('observes a real stable host without disclosing its machine identifier', async () => {
  const before = await readRetirementHost(), after = await readRetirementHost();
  expect(before.hostId).toMatch(/^[a-f0-9]{64}$/u);
  expect(after).toEqual({ hostId: before.hostId, platform: process.platform });
});
it('honors cancellation before probing the host', async () => {
  await expect(readRetirementHost(AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
});
