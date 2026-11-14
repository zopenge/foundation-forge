import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertSourceFrozen, readCommittedConfig } from '../src/node/source.js';
import { ReleaseError } from '../src/node/errors.js';
import { sourceObservationFixture, type SourceObservationFixture, type SourceObservationCall } from './helpers/source-observation-fixture.js';

const fixtures: SourceObservationFixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await sourceObservationFixture(); fixtures.push(f); return f; };
const configCalls = (f: SourceObservationFixture): SourceObservationCall[] => [
  { kind: 'git', args: ['rev-parse', '--verify', '--quiet', `${f.source.sha}:release.config.json`], output: f.source.configBlobOid },
  { kind: 'stream', args: ['cat-file', 'blob', f.source.configBlobOid], output: Buffer.from(JSON.stringify(f.source.config)), allowedExitCodes: [0] },
];
const frozenCalls = (f: SourceObservationFixture): SourceObservationCall[] => [
  { kind: 'git', args: ['rev-parse', '--show-toplevel'], output: f.source.root },
  { kind: 'git', args: ['config', '--get-regexp', '^remote\\.origin\\.(url|pushurl)$'], output: 'remote.origin.url https://github.com/fixture/repository.git' },
  { kind: 'git', args: ['rev-parse', 'HEAD'], output: f.source.sha },
  { kind: 'git', args: ['branch', '--show-current'], output: 'dev' },
  { kind: 'git', args: ['config', '--get', 'remote.origin.url'], output: 'https://github.com/fixture/repository.git' },
  { kind: 'git', args: ['diff', '--quiet', '--'], output: '' },
  { kind: 'git', args: ['diff', '--cached', '--quiet', '--'], output: '' },
  { kind: 'stream', args: ['cat-file', 'blob', f.source.configBlobOid], output: Buffer.from(JSON.stringify(f.source.config)), allowedExitCodes: [0] },
];
const failAt = (f: SourceObservationFixture, script: SourceObservationCall[], index: number, failure: Error) => {
  const target = script[index]; if (!target) throw new Error('invalid failure point');
  f.expect([...script.slice(0, index), { ...target, failure }]);
};

it.each([
  new ReleaseError('GIT_FAILED', { exitCode: null, termination: 'start-failure' }),
  new ReleaseError('GIT_FAILED', { exitCode: 128, termination: 'termination-failure' }),
  new ReleaseError('GIT_FAILED', { exitCode: 128, termination: 'exit' }),
  new ReleaseError('COMMAND_TIMEOUT', { step: 'git' }), new ReleaseError('CANCELLED'), new ReleaseError('PROCESS_STATE_UNKNOWN'),
])('preserves committed-config observation failure $code with $details', async failure => {
  const f = await fixture(); failAt(f, configCalls(f), 0, failure);
  await expect(readCommittedConfig(f.execution, f.source.sha, 'release.config.json')).rejects.toBe(failure); f.assertConsumed();
  f.expect(configCalls(f));
  await expect(readCommittedConfig(f.execution, f.source.sha, 'release.config.json')).resolves.toMatchObject({ config: f.source.config });
  f.assertConsumed();
});

it.each(['GIT_FAILED', 'COMMAND_TIMEOUT', 'PROCESS_STATE_UNKNOWN'] as const)('preserves %s when frozen-source observation fails', async code => {
  const f = await fixture();
  const failure = new ReleaseError(code, { step: 'git', ...(code === 'GIT_FAILED' ? { exitCode: null, termination: 'termination-failure' } : {}) });
  failAt(f, frozenCalls(f), 0, failure);
  await expect(assertSourceFrozen(f.source, f.execution)).rejects.toBe(failure); f.assertConsumed();
  f.expect(frozenCalls(f)); await expect(assertSourceFrozen(f.source, f.execution)).resolves.toBeUndefined(); f.assertConsumed();
});

it.each([{ point: 'remote', index: 1 }, { point: 'worktree', index: 5 }, { point: 'index', index: 6 }])(
  'preserves abnormal closure with exit code one during $point observation', async ({ index }) => {
    const f = await fixture(), failure = new ReleaseError('GIT_FAILED', { step: 'git', exitCode: 1, termination: 'termination-failure' });
    failAt(f, frozenCalls(f), index, failure);
    await expect(assertSourceFrozen(f.source, f.execution)).rejects.toBe(failure); f.assertConsumed();
    f.expect(frozenCalls(f)); await expect(assertSourceFrozen(f.source, f.execution)).resolves.toBeUndefined(); f.assertConsumed();
    expect(await readFile(resolve(f.source.root, f.source.configPath))).toEqual(Buffer.from(JSON.stringify(f.source.config)));
  });
