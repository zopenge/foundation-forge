import { expect, it } from 'vitest';
import { hasSubsequentBoot, readRetirementHost } from '../src/node/retirement-host.js';

const windows = { platform: 'win32' as const, hostId: 'a'.repeat(64), uptimeSeconds: 1000 };
it('requires an actual counter reset on the same Windows host, not elapsed wall time', () => {
  expect(hasSubsequentBoot(windows, { ...windows, uptimeSeconds: 50 })).toBe(true);
  for (const observation of [{ ...windows, uptimeSeconds: 1001 }, { ...windows, uptimeSeconds: 999 },
    { ...windows, uptimeSeconds: 1, hostId: 'b'.repeat(64) }, { ...windows, uptimeSeconds: Number.NaN }]) {
    expect(hasSubsequentBoot(windows, observation)).toBe(false);
  }
});
it('requires distinct Linux kernel boot IDs on the same host', () => {
  const before = { ...windows, platform: 'linux' as const, bootId: '10000000-0000-4000-8000-000000000001' };
  expect(hasSubsequentBoot(before, { ...before, uptimeSeconds: 1 })).toBe(false);
  expect(hasSubsequentBoot(before, { ...before, bootId: '10000000-0000-4000-8000-000000000002' })).toBe(true);
});
it('observes a real stable host without disclosing its machine identifier', async () => {
  const before = await readRetirementHost(), after = await readRetirementHost();
  expect(before.hostId).toMatch(/^[a-f0-9]{64}$/u);
  expect(after.hostId).toBe(before.hostId);
  expect(after.uptimeSeconds).toBeGreaterThanOrEqual(before.uptimeSeconds);
  expect(hasSubsequentBoot(before, after)).toBe(false);
});
it('honors cancellation before probing the host', async () => {
  await expect(readRetirementHost(AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
});
