import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Execution } from '../src/node/execution.js';
import * as boundary from './helpers/source-observation-fixture.js';

const fixtures: Awaited<ReturnType<typeof boundary.sourceObservationFixture>>[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await boundary.sourceObservationFixture(); fixtures.push(f); return f; };

it('prepares independent real configuration bytes without Git and disposes only its own root', async () => {
  vi.stubEnv('PATH', '');
  const run = vi.spyOn(Execution.prototype, 'run').mockImplementation(async () => { throw new Error('unexpected real command'); });
  expect(typeof boundary.sourceObservationFixture).toBe('function');
  const a = await fixture(), b = await fixture();
  expect(a.source.root).not.toBe(b.source.root);
  expect((await lstat(a.source.root, { bigint: true })).ino).not.toBe((await lstat(b.source.root, { bigint: true })).ino);
  expect(await readFile(resolve(a.source.root, a.source.configPath))).toEqual(Buffer.from(JSON.stringify(a.source.config)));
  await a.dispose();
  await expect(lstat(a.source.root)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(b.source.root, b.source.configPath))).toEqual(Buffer.from(JSON.stringify(b.source.config)));
  expect(run).not.toHaveBeenCalled();
});

it('rejects unknown and out-of-order git, stream and application commands before any OS execution', async () => {
  const run = vi.spyOn(Execution.prototype, 'run').mockImplementation(async () => { throw new Error('unexpected real command'); });
  const f = await fixture();
  await expect(f.execution.git(['push', 'origin', 'HEAD'])).rejects.toThrow('SOURCE_OBSERVATION_COMMAND');
  await expect(f.execution.streamGit(['cat-file', 'blob', 'unknown'], () => {})).rejects.toThrow('SOURCE_OBSERVATION_COMMAND');
  await expect(f.execution.run('application', { command: 'node' }, 'CHECK_FAILED')).rejects.toThrow('SOURCE_OBSERVATION_COMMAND');
  f.expect([{ kind: 'git', args: ['rev-parse', 'HEAD'], output: f.source.sha }]);
  await expect(f.execution.git(['rev-parse', '--verify', 'HEAD'])).rejects.toThrow('SOURCE_OBSERVATION_COMMAND');
  await expect(f.execution.git(['rev-parse', 'HEAD'])).resolves.toBe(f.source.sha);
  f.assertConsumed();
  expect(run).not.toHaveBeenCalled();
});
