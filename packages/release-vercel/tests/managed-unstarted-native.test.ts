import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { verifyUnstartedConsumer } from '../package-consumer/unstarted-consumer.mjs';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { committedFixtureSource } from './helpers/committed-fixture-source.js';
import { managedFixture } from './helpers/managed-fixture.js';

it.runIf(process.platform === 'win32')('retires a real unbound first-message failure through the public CLI and preserves UNKNOWN after slot reuse', async () => {
  const value = await managedFixture();
  try {
    const execute = (cwd: string, command: string, args: string[]) => {
      const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000 });
      if (result.stderr) process.stderr.write(result.stderr);
      expect(result.status, result.error?.message ?? result.stdout).toBe(0);
      return result.stdout;
    };
    // 原worker只破坏真实helper的首消息；Git来源、Job、停止、空集合和CLI退役不替换。
    const observe = await verifyUnstartedConsumer({ cwd: value.cwd, binary: resolve(import.meta.dirname, '../dist/cli.js'), sha: value.sha, execute });
    const evidence = await observe();
    expect(evidence).toMatchObject({ failed: { ok: false, candidateSha: value.sha, processes: { status: 'unknown', knownCount: 0 },
      error: { code: 'PROCESS_STATE_UNKNOWN' } }, retired: { ok: true, processes: { status: 'unknown', knownCount: 0 },
      retirement: { cessation: 'recorded-empty-unstarted-scope', historicalVerification: 'unknown' } } });
    const statePath = resolve(value.cwd, 'state/release-slot/state.json'), state = await readFile(statePath);
    const source = await committedFixtureSource(value, value.sha), next = await openManagedSlot(source, value.execution);
    try { expect(next.runId).not.toBe(JSON.parse(state.toString('utf8')).runId); }
    finally { await next.lock.release(); }
    expect(await readFile(statePath)).toEqual(state);
    await observe();
    expect(value.ref('dev')).toBe(value.initial); expect(value.ref('main')).toBe(value.initial);
  } finally { await value.dispose(); }
}, 180_000);
