import { deepStrictEqual } from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Execution } from '../../src/node/execution.js';
import type { FrozenSource } from '../../src/node/release-context.js';
import { validateReleaseConfig } from '../../src/node/config.js';
import { prebuiltConfiguration } from './prebuilt-configuration.js';

export interface SourceObservationCall {
  readonly kind: 'git' | 'stream'; readonly args: readonly string[];
  readonly output?: string | Uint8Array; readonly failure?: Error;
  readonly allowedExitCodes?: readonly number[];
}
export interface SourceObservationFixture {
  readonly source: FrozenSource; readonly execution: Execution; readonly calls: readonly SourceObservationCall[];
  expect(calls: readonly SourceObservationCall[]): void;
  assertConsumed(): void;
  dispose(): Promise<void>;
}
export async function sourceObservationFixture(): Promise<SourceObservationFixture> {
  const parent = resolve(process.env.FORGE_CHECK_JOB_TEMP ?? resolve(import.meta.dirname, '../../../../tmp'), 'source-observation');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'r-')), original = await lstat(root, { bigint: true });
  const canonical = await realpath(root);
  const dispose = async () => {
    let current;
    try { current = await lstat(root, { bigint: true }); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
    if (current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || await realpath(root) !== canonical)
      throw new Error('SOURCE_OBSERVATION_IDENTITY');
    await rm(root, { recursive: true, force: true });
  };
  try {
    const config = validateReleaseConfig(prebuiltConfiguration()), bytes = Buffer.from(JSON.stringify(config));
    // SHA 只是显式协议输入；不创建提交、进程身份、关闭凭据或发布成功记录。
    const source: FrozenSource = { root: canonical, sha: createHash('sha1').update(randomUUID()).digest('hex'),
      configPath: 'release.config.json', config, configSha256: createHash('sha256').update(bytes).digest('hex'),
      configBlobOid: createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'),
      fetchUrl: 'https://github.com/fixture/repository.git' };
    await writeFile(resolve(root, source.configPath), bytes);
    const pending: SourceObservationCall[] = [], calls: SourceObservationCall[] = [];
    const take = (kind: SourceObservationCall['kind'], args: readonly string[], allowedExitCodes?: readonly number[]) => {
      const next = pending[0];
      try { deepStrictEqual({ kind, args, allowedExitCodes }, { kind: next?.kind, args: next?.args, allowedExitCodes: next?.allowedExitCodes }); }
      catch (cause) { throw new Error('SOURCE_OBSERVATION_COMMAND', { cause }); }
      pending.shift(); calls.push({ kind, args: [...args], ...(allowedExitCodes ? { allowedExitCodes } : {}) });
      if (next?.failure) throw next.failure;
      return next?.output;
    };
    const execution = new Execution(canonical, config, undefined, []);
    execution.git = async args => {
      const output = take('git', args);
      if (typeof output !== 'string') throw new Error('SOURCE_OBSERVATION_OUTPUT');
      return output;
    };
    execution.streamGit = async (args, consume, allowedExitCodes = [0]) => {
      const output = take('stream', args, allowedExitCodes);
      if (!(output instanceof Uint8Array)) throw new Error('SOURCE_OBSERVATION_OUTPUT');
      consume(output);
    };
    execution.run = async () => { throw new Error('SOURCE_OBSERVATION_COMMAND'); };
    return { source, execution, calls, dispose,
      expect: script => { if (pending.length) throw new Error('SOURCE_OBSERVATION_UNCONSUMED'); pending.push(...script); },
      assertConsumed: () => { if (pending.length) throw new Error('SOURCE_OBSERVATION_UNCONSUMED'); } };
  } catch (error) { await dispose(); throw error; }
}
