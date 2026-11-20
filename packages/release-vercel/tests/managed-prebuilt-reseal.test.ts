import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReleaseConfig } from '../src/contracts.js';
import { runRelease } from '../src/node.js';
import { Execution, vercelInvocation } from '../src/node/execution.js';
import { installReadQueryComponentExecution } from './helpers/component-command-runtime.mjs';

let restoreExecution: (() => void) | undefined;
beforeEach(() => { restoreExecution = installReadQueryComponentExecution(Execution); });
afterEach(() => { restoreExecution?.(); });

it('reseals changed bytes in the same slot after stopped create admission without remote effects', async () => {
  expect(vi.isMockFunction(vercelInvocation)).toBe(true);
  const value = await fixture(true);
  const control = resolve(value.root, 'release-input.txt');
  const configPath = resolve(value.cwd, 'release.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ReleaseConfig;
  if (config.source.mode !== 'managed-commit' || !config.delivery) throw new Error('expected managed prebuilt config');
  const readInput = `require('node:fs').readFileSync(${JSON.stringify(control)}, 'utf8')`;
  await writeFile(configPath, JSON.stringify({
    ...config,
    source: { ...config.source, prepare: [{ command: 'node', args: ['-e',
      `const fs = require('node:fs'); const root = '.vercel/output'; fs.mkdirSync(root + '/static', { recursive: true }); fs.writeFileSync(root + '/config.json', '{"version":3}'); fs.writeFileSync(root + '/static/index.html', ${readInput});`] }] },
    delivery: { ...config.delivery, admission: [{ command: 'node', args: ['-e', `process.exit(${readInput} === 'blocked' ? 1 : 0)`] }] },
  }));
  const sha = value.commit();
  const options = { command: 'publish', cwd: value.cwd, transport: value.transport } as const;
  await writeFile(control, 'blocked');
  const stopped = await runRelease(options);
  const untouched = { developmentPush: 'not-attempted', releasePush: 'not-attempted', deploymentCreate: 'not-attempted',
    deploymentPromote: 'not-attempted', versionAliasAssign: 'not-attempted' };
  expect(stopped, JSON.stringify(stopped.error)).toMatchObject({ ok: false, candidateSha: sha, stage: 'admission',
    error: { code: 'ADMISSION_FAILED' }, processes: { status: 'closed' }, effects: untouched });
  expect(stopped.prebuilt?.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(stopped.prebuilt?.deploymentId).toBeUndefined();
  expect(value.promotions()).toBe(0);
  expect(value.assignments()).toBe(0);
  await expect(value.creates()).rejects.toMatchObject({ code: 'ENOENT' });
  const slot = resolve(value.cwd, 'state/release-slot');
  const historyPath = resolve(slot, 'history', `${stopped.runId}.json`);
  const originalHistory = await readFile(historyPath, 'utf8');
  const originalReceipt = await readFile(resolve(slot, 'latest-publish.json'), 'utf8');
  expect(JSON.parse(originalHistory)).toMatchObject({ snapshot: { publish: originalReceipt }, stopped: { effects: untouched } });
  await expect(readFile(resolve(slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });

  await writeFile(control, 'admitted');
  const published = await runRelease(options);
  expect(published, JSON.stringify(published.error)).toMatchObject({ ok: true, candidateSha: sha, slotId: stopped.slotId,
    prebuilt: { deploymentId: 'dpl_candidate', promotionVerified: true }, processes: { status: 'closed' } });
  expect(published.prebuilt?.artifactSha256).not.toBe(stopped.prebuilt?.artifactSha256);
  expect(published.runId).not.toBe(stopped.runId);
  expect(await readFile(historyPath, 'utf8')).toBe(originalHistory);
  expect(await value.creates()).toBe(1);
  expect(value.assignments()).toBe(1);
  expect(value.promotions()).toBe(1);
  await expect(readFile(resolve(slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 120_000);

it('continues the exact accepted candidate with its sealed inputs and original release phases', async () => {
  expect(vi.isMockFunction(vercelInvocation)).toBe(true);
  const value = await fixture(true, undefined, { idempotent: true, jobs: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] });
  value.hooks.deployment = { readyState: 'ERROR' };
  const options = { command: 'publish', cwd: value.cwd, transport: value.transport } as const;
  const stopped = await runRelease(options);
  expect(stopped, JSON.stringify(stopped.error)).toMatchObject({ ok: false, stage: 'deployment', processes: { status: 'closed' },
    prebuilt: { deploymentId: 'dpl_candidate', createEffect: 'accepted', promoteEffect: 'not-attempted', acceptanceVerified: false } });
  if (!stopped.runId || !stopped.prebuilt?.deploymentId) throw new Error('accepted candidate receipt required');
  const { sourceSha: sha, configSha256, artifactSha256, deploymentId } = stopped.prebuilt;
  const resumePrebuilt = { runId: stopped.runId, sha, configSha256, artifactSha256, deploymentId };
  const receiptPath = resolve(value.cwd, 'state/release-slot/latest-publish.json');
  const archivedPath = resolve(value.cwd, 'state/release-slot/history', `${stopped.runId}.json`);
  const before = await readFile(archivedPath, 'utf8'), original = await readFile(receiptPath, 'utf8');
  delete value.hooks.deployment;
  const status = await runRelease({ ...options, command: 'status' });
  expect(status, JSON.stringify(status.error)).toMatchObject({ ok: true, runId: stopped.runId, deployment: { id: deploymentId, state: 'READY' },
    prebuilt: { artifactSha256, versionAlias: { effect: 'not-attempted' } } });
  const mismatched = await runRelease({ ...options, resumePrebuilt: { ...resumePrebuilt, artifactSha256: '0'.repeat(64) } });
  expect(mismatched, JSON.stringify(mismatched.error)).toMatchObject({ ok: false, error: { code: 'RECOVERY_REQUIRED', details: { reason: 'PREBUILT_RESUME_BINDING' } } });
  expect(await readFile(receiptPath, 'utf8')).toBe(original);
  value.hooks.deployment = { readyState: 'ERROR' };
  const interrupted = await runRelease({ ...options, resumePrebuilt });
  expect(interrupted, JSON.stringify(interrupted.error)).toMatchObject({ ok: false, stage: 'deployment', prebuilt: { deploymentId, artifactSha256, promoteEffect: 'not-attempted' } });
  expect(interrupted.runId).not.toBe(stopped.runId);
  expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ report: { runId: interrupted.runId } });
  if (!interrupted.runId) throw new Error('continuation receipt required');
  delete value.hooks.deployment;
  const result = await runRelease({ ...options, resumePrebuilt: { ...resumePrebuilt, runId: interrupted.runId } });
  expect(result, JSON.stringify(result.error)).toMatchObject({ ok: true, runId: expect.any(String), slotId: stopped.slotId,
    prebuilt: { deploymentId, artifactSha256, promotionVerified: true }, completion: { status: 'completed' } });
  expect(result.runId).not.toBe(stopped.runId);
  expect(result.steps.map(step => step.name)).toEqual(['admission:version-alias:0', 'acceptance:0', 'admission:promote:0', 'admission:completion:0', 'completion:0']);
  expect(await value.creates()).toBe(1);
  expect(value.assignments()).toBe(1);
  expect(value.promotions()).toBe(1);
  expect(await readFile(archivedPath, 'utf8')).toBe(before);
}, 120_000);
