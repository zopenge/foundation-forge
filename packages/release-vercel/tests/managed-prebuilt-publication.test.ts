import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { runRelease } from '../src/node.js';
import { ReleaseError } from '../src/node/errors.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('managed prebuilt candidate recovery through public entry', () => {
it('publishes once and observes the saved exact ID through status and verify without Git integration', async () => {
    const value = await fixture();
    const published = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(published, JSON.stringify(published.error)).toMatchObject({ ok: true, processes: { status: 'closed' },
      prebuilt: { deploymentId: 'dpl_candidate', promotionVerified: true } });
    const before = await readFile(resolve(value.cwd, '.tmp/release-slot/latest-publish.json'));
    for (const command of ['status', 'verify'] as const) {
      const observed = await runRelease({ command, cwd: value.cwd, transport: value.transport });
      expect(observed, JSON.stringify(observed.error)).toMatchObject({ ok: true, candidateSha: value.sha, deployment: { id: 'dpl_candidate' } });
    }
    expect(await readFile(resolve(value.cwd, '.tmp/release-slot/latest-publish.json'))).toEqual(before);
    expect(await value.creates()).toBe(1); expect(value.promotions()).toBe(1);
    expect(value.paths.every(path => !path.startsWith('/v6/deployments'))).toBe(true);
    expect(value.ref('dev')).toBe(value.initial); expect(value.ref('main')).toBe(value.initial);
  }, 300_000);
it('observes an accepted promotion with a lost response and never promotes the candidate twice', async () => {
    const value = await fixture(); value.hooks.promote = () => { throw new ReleaseError('VERCEL_API'); };
    const failed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    let receiptDiagnostic: unknown;
    // 只在未到达预期阶段时读取本fixture回执，保留锁释放等收尾之前的主体首错。
    if (!failed.prebuilt && failed.recovery) {
      try {
        const receipt = JSON.parse(await readFile(failed.recovery.reportPath, 'utf8')) as { report: { error?: unknown; stage?: unknown } };
        receiptDiagnostic = { error: receipt.report.error, stage: receipt.report.stage };
      } catch (error) { receiptDiagnostic = { readError: error instanceof Error ? error.message : String(error) }; }
    }
    expect(failed, JSON.stringify({ error: failed.error, stage: failed.stage, processes: failed.processes, budget: failed.budget,
      steps: failed.steps.map(({ name, ok, durationMs, exitCode }) => ({ name, ok, durationMs, exitCode })), receiptDiagnostic }))
      .toMatchObject({ ok: false, prebuilt: { deploymentId: 'dpl_candidate', promoteEffect: 'unknown' } });
    delete value.hooks.promote;
    const observed = await runRelease({ command: 'status', cwd: value.cwd, transport: value.transport });
    expect(observed, JSON.stringify(observed.error)).toMatchObject({ ok: true, deployment: { id: 'dpl_candidate' } });
    const resumed = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(resumed, JSON.stringify(resumed.error)).toMatchObject({ ok: true, prebuilt: { deploymentId: 'dpl_candidate', promotionVerified: true } });
    expect(await value.creates()).toBe(1); expect(value.promotions()).toBe(1);
  }, 300_000);
});
