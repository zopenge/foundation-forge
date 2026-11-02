import { describe, expect, it } from 'vitest';
import { validateReleaseConfig } from '../src/node/config.js';
import { configDigest } from '../src/node/source.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const normalized = prebuiltConfiguration();
const managedConfig = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== 'delivery'));
const workspaceConfig = { ...managedConfig, source: { mode: 'workspace' } };

const delivery = { mode: 'prebuilt', maxFiles: 10_000, maxBytes: 268_435_456,
  concurrencyControl: { mode: 'external-serialization', scope: 'fixture-project' },
  admission: [{ command: 'node', args: ['admission.mjs'] }] };

describe('explicit prebuilt delivery admission', () => {
  it('accepts bounded prebuilt delivery only with a frozen managed source', () => {
    expect(validateReleaseConfig({ ...managedConfig, delivery })).toEqual({ ...managedConfig, delivery });
  });
  it('preserves the existing normalized configuration and digest when delivery is absent', async () => {
    const original = validateReleaseConfig(managedConfig);
    expect(Object.hasOwn(original, 'delivery')).toBe(false);
    expect(await configDigest(original)).toBe(await configDigest(validateReleaseConfig(JSON.parse(JSON.stringify(managedConfig)))));
  });
  it.each([
    { ...workspaceConfig, delivery },
    { ...managedConfig, delivery: { ...delivery, mode: 'automatic' } },
    { ...managedConfig, delivery: { ...delivery, admission: [] } },
    { ...managedConfig, delivery: { ...delivery, admission: [{ command: 'node', unknown: true }] } },
    { ...managedConfig, delivery: { ...delivery, maxFiles: 0 } },
    { ...managedConfig, delivery: { ...delivery, maxFiles: 10_001 } },
    { ...managedConfig, delivery: { ...delivery, maxBytes: 0 } },
    { ...managedConfig, delivery: { ...delivery, outputPath: '../source' } },
    { ...managedConfig, delivery: { ...delivery, automaticUpgrade: true } },
    { ...managedConfig, delivery: Object.fromEntries(Object.entries(delivery).filter(([key]) => key !== 'concurrencyControl')) },
    { ...managedConfig, delivery: { ...delivery, concurrencyControl: { mode: 'local-only', scope: 'fixture' } } },
    { ...managedConfig, delivery: { ...delivery, concurrencyControl: { mode: 'external-serialization', scope: '' } } },
    { ...managedConfig, delivery: null },
  ])('rejects unbounded, implicit or unreviewed delivery inputs %#', value => {
    expect(() => validateReleaseConfig(value)).toThrow('CONFIG_INVALID');
  });
});
