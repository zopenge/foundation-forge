import { boundary, fixture, runRelease } from './helpers/completion-publication-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { git } from './helpers/managed-fixture.js';
import { waitForManagedReady } from './helpers/managed-readiness.js';

it('executes completion after exact production proof under the original lock, native scope and protected metadata', async () => {
  const checkpoint = (phase: string) => { boundary.phases.push({ phase, at: performance.now(), utc: new Date().toISOString() }); };
  checkpoint('fixture:requested');
  const value = await fixture({ mode: 'wait' });
  checkpoint('fixture:ready');
  vi.stubEnv('FORGE_RELEASE_COMPLETION_CONTEXT', '{"productionUrl":"https://forged.invalid"}');
  vi.stubEnv('FORGE_RELEASE_URL', 'https://forged.invalid');
  vi.stubEnv('FORGE_RELEASE_DEPLOYMENT_ID', 'dpl_forged');
  vi.stubEnv('FORGE_RELEASE_VERSION_URL', 'https://inherited.invalid');
  vi.stubEnv('FORGE_RELEASE_CONFIG_SHA256', 'f'.repeat(64));
  vi.stubEnv('FORGE_RELEASE_CANDIDATE_CONTEXT', '{"deploymentId":"dpl_inherited"}');
  // 只界定准备与任务启动请求，不把这个通知当作真实身份或关闭证明；原180秒总时限仍生效。
  const started = new Promise<void>(accept => { boundary.completionRequested = () => { checkpoint('completion:requested'); accept(); }; });
  checkpoint('publish:requested');
  const pending = runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport }).then(report => {
    checkpoint('publish:finished'); boundary.steps = report.steps.map(({ name, durationMs, ok }) => ({ name, durationMs, ok })); return report;
  });
  try {
    try { await waitForManagedReady(pending, async () => (await value.results()).length === 1, { started }); }
    catch (error) {
      const failures = [error];
      try {
        const state = JSON.parse(await readFile(resolve(value.cwd, 'state/release-slot/state.json'), 'utf8'));
        const observation = { stage: state.stage, completion: state.completion?.status,
          lastCommands: state.processes.slice(-3).map((item: { name: string; status: string }) => ({ name: item.name, status: item.status })) };
        failures.push(new Error(JSON.stringify(observation)));
      } catch (readError) { failures.push(readError); }
      throw new AggregateError(failures, 'completion readiness failed', { cause: error });
    }
    checkpoint('completion:observed');
    const live = JSON.parse(await readFile(resolve(value.cwd, 'state/release-slot/state.json'), 'utf8'));
    expect(live.completion).toMatchObject({ status: 'running', attempts: [{ status: 'running' }] });
    checkpoint('concurrent-check:requested');
    const concurrent = await runRelease({ command: 'check', cwd: value.cwd, transport: value.transport });
    checkpoint('concurrent-check:finished');
    expect(concurrent, JSON.stringify(concurrent.error)).toMatchObject({ ok: false,
      error: { code: 'RECOVERY_REQUIRED', details: { reason: 'OWNER_NOT_INACTIVE', owner: 'active', runId: live.runId } } });
    checkpoint('running-status:requested');
    const status = await runRelease({ command: 'status', cwd: value.cwd, transport: value.transport });
    checkpoint('running-status:finished');
    expect(status, JSON.stringify(status.error)).toMatchObject({ ok: false, completion: { status: 'running' } });
    expect(git(resolve(value.cwd, 'state/release-slot/checkout'), 'rev-parse', 'HEAD')).toBe(value.sha);
  } finally { checkpoint('control:release'); await writeFile(value.control, 'ok'); }
  const report = await pending;
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, stage: 'complete', processes: { status: 'closed' },
    prebuilt: { promoteEffect: 'accepted', promotionVerified: true, versionAlias: { verified: true } },
    completion: { status: 'completed', publicationRunId: report.runId, attempts: [{ status: 'completed', jobs: [{ index: 0, status: 'completed' }] }] } });
  expect(report).not.toHaveProperty('completionInput');
  expect(JSON.parse(report.steps.find(step => step.name === 'prepare:0')?.stdout ?? '')).toEqual({
    url: `https://fixture-${value.sha}.vercel.app`, config: report.configSha256, context: '' });
  const observed = await value.results();
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ cwd: resolve(value.cwd, 'state/release-slot/checkout'), lockRunId: report.runId,
    context: { sourceSha: value.sha, configSha256: report.configSha256, artifactSha256: report.prebuilt?.artifactSha256,
      productionUrl: 'https://fixture.example.invalid', deploymentId: 'dpl_candidate' },
    metadata: { FORGE_RELEASE_COMMAND: 'publish', FORGE_RELEASE_SHA: value.sha, FORGE_RELEASE_URL: 'https://fixture.example.invalid',
      FORGE_RELEASE_PHASE: 'completion', FORGE_RELEASE_DEPLOYMENT_ID: 'dpl_candidate', FORGE_RELEASE_VERSION_URL: `https://fixture-${value.sha}.vercel.app` } });
  const state = JSON.parse(await readFile(resolve(value.cwd, 'state/release-slot/state.json'), 'utf8'));
  const command = state.processes.find((item: { name: string }) => item.name === 'completion:0');
  expect(command).toMatchObject({ status: 'closed', closure: { exitCode: 0, ownedScope: { status: 'closed', reason: 'normal', empty: true } } });
  expect(command.terminalSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(report.completion?.attempts[0]?.jobs[0]?.commandId).toBe(command.id);
  expect(report.steps.find(step => step.name === 'completion:0')).toMatchObject({ ok: true, exitCode: 0 });
  expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  const receiptPath = resolve(value.cwd, 'state/release-slot/latest-publish.json'), receipt = await readFile(receiptPath);
  for (const command of ['status', 'verify'] as const) {
    checkpoint(`finished-${command}:requested`);
    const result = await runRelease({ command, cwd: value.cwd, transport: value.transport });
    checkpoint(`finished-${command}:finished`);
    expect(result, JSON.stringify(result.error)).toMatchObject({ ok: true, candidateSha: value.sha,
      deployment: { id: 'dpl_candidate' }, completion: { status: 'completed' } });
  }
  expect(await readFile(receiptPath)).toEqual(receipt);
  expect(await value.results()).toHaveLength(1);
  expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  expect(value.ref('dev')).toBe(value.initial); expect(value.ref('main')).toBe(value.initial);
  checkpoint('test:finished');
}, 180_000);
