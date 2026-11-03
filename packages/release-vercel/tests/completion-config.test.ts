import { describe, expect, it } from 'vitest';
import { parseArguments } from '../src/cli-arguments.js';
import { validateReleaseConfig } from '../src/node/config.js';
import { configDigest } from '../src/node/source.js';
import { runRelease } from '../src/node/release.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const original = prebuiltConfiguration();
const completion = { idempotent: true, jobs: [{ command: 'node', args: ['completion.mjs'], timeoutMs: 1000 }] };

describe('explicit bounded post-promotion completion', () => {
  it('accepts an explicit idempotent job list and binds it into the frozen configuration digest', async () => {
    const normalized = validateReleaseConfig({ ...original, completion });
    expect(normalized).toEqual({ ...original, completion });
    expect(await configDigest(normalized)).not.toBe(await configDigest(original));
  });
  it('preserves the existing configuration and digest when completion is absent', async () => {
    expect(validateReleaseConfig(original)).toEqual(original);
    expect(Object.hasOwn(validateReleaseConfig(original), 'completion')).toBe(false);
    expect(await configDigest(validateReleaseConfig(original))).toBe(await configDigest(original));
  });
  it.each([
    undefined, null, [], {}, { jobs: completion.jobs }, { ...completion, idempotent: false },
    { ...completion, jobs: [] }, { ...completion, jobs: Array.from({ length: 33 }, () => completion.jobs[0]) },
    { ...completion, jobs: [{ command: 'run.cmd' }] }, { ...completion, jobs: [{ command: 'node', timeoutMs: 0 }] },
    { ...completion, jobs: [{ command: 'node', timeoutMs: 3_600_001 }] },
    { ...completion, jobs: [{ command: 'node', env: { FORGE_RELEASE_SHA: 'forged' } }] },
    { ...completion, retryAutomatically: true },
  ])('rejects an ambiguous, implicit or unbounded completion declaration %#', value => {
    expect(() => validateReleaseConfig({ ...original, completion: value })).toThrow('CONFIG_INVALID');
  });
  it.each([
    { ...original, source: { mode: 'workspace' }, delivery: undefined },
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'delivery')),
  ])('rejects completion outside managed prebuilt delivery %#', value => {
    expect(() => validateReleaseConfig({ ...value, completion })).toThrow('CONFIG_INVALID');
  });
  it('parses the explicit verify retry flag without consuming a following value', () => {
    expect(parseArguments(['verify', '--retry-completion', '--sha', 'a'.repeat(40)]))
      .toMatchObject({ command: 'verify', retryCompletion: true, sha: 'a'.repeat(40) });
    expect(parseArguments(['verify', '--sha', 'a'.repeat(40), '--retry-completion']))
      .toMatchObject({ command: 'verify', retryCompletion: true });
    expect(parseArguments(['verify'])).not.toHaveProperty('retryCompletion');
  });
  it.each([
    ['publish', '--retry-completion'], ['check', '--retry-completion'], ['status', '--retry-completion'],
    ['recover', '--retry-completion'], ['verify', '--retry-completion', '--retry-completion'],
    ['verify', '--retry-completion', 'true'],
  ].map(args => ({ args })))('rejects retry in the wrong command or an ambiguous flag list %j', ({ args }) => {
    expect(() => parseArguments(args)).toThrow('ARGUMENT_INVALID');
  });
  it('rejects SDK retries outside verify before accessing a source or starting a command', async () => {
    const report = await runRelease({ command: 'check', cwd: import.meta.dirname, config: original, retryCompletion: true });
    expect(report).toMatchObject({ ok: false, error: { code: 'ARGUMENT_INVALID' }, steps: [] });
  });
  it('rejects explicit retries without completion before any workspace execution', async () => {
    const config = validateReleaseConfig({ ...Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'delivery')), source: { mode: 'workspace' } });
    const report = await runRelease({ command: 'verify', cwd: import.meta.dirname, config, retryCompletion: true });
    expect(report).toMatchObject({ ok: false, error: { code: 'SOURCE_UNSUPPORTED', details: { reason: 'COMPLETION_NOT_CONFIGURED' } }, steps: [] });
  });
});
