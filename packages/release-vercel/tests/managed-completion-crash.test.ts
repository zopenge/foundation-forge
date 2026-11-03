import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { hasVerifiedManagedStop } from '../src/node/managed-closure.js';
import { inspectManagedRecovery, readManagedLocation } from '../src/node/managed-recovery.js';
import type { ManagedState } from '../src/node/release-context.js';
import { serveCompletionTransport } from '../package-consumer/completion-rpc.mjs';
import { completionFixture } from './helpers/completion-fixture.js';
import { fixtureExec } from './helpers/fixture-exec.js';
import { managedRuns } from './helpers/managed-runs.js';

const runs = managedRuns();
const fixtures: { value: Awaited<ReturnType<typeof completionFixture>>; stopped: boolean; server?: Awaited<ReturnType<typeof serveCompletionTransport>> }[] = [];
afterEach(async () => {
  await runs.close();
  for (const fixture of fixtures.splice(0)) {
    await fixture.server?.close();
    // 只有真实coordinator已退出且所有业务子scope停止已证实，才在worker内回收；否则留给父Job核验。
    if (fixture.stopped) await fixture.value.dispose();
  }
});
it('recovers the archived original intent when the coordinator exits before its publish receipt exists', async () => {
  const value = await completionFixture({ mode: 'fail' }), entry: typeof fixtures[number] = { value, stopped: false }; fixtures.push(entry);
  const server = await serveCompletionTransport(value.transport); entry.server = server;
  const api = pathToFileURL(resolve(import.meta.dirname, '../dist/node.js')).href;
  await expect(fixtureExec(process.execPath, [resolve(import.meta.dirname, '../package-consumer/completion-worker.mjs'),
    api, value.cwd, server.endpoint, value.createCounter, 'crash-publish-receipt'], { cwd: value.cwd, timeout: 180_000 }))
    .rejects.toMatchObject({ code: 71 });
  const location = await readManagedLocation(value.cwd, 'release.config.json');
  const state = JSON.parse(await readFile(location.paths.statePath, 'utf8')) as ManagedState;
  expect(state.processes.every(hasVerifiedManagedStop)).toBe(true); entry.stopped = true;
  expect(await inspectManagedRecovery(state, location.paths)).toMatchObject({ owner: 'inactive', processes: 'closed' });
  expect(state.completion).toMatchObject({ status: 'failed' });
  await expect(readFile(resolve(location.paths.slotRoot, 'latest-publish.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const recovered = await runs.run({ command: 'recover', cwd: value.cwd, transport: value.transport });
  expect(recovered, JSON.stringify(recovered.error)).toMatchObject({ ok: true, processes: { status: 'closed' }, completion: { status: 'failed' } });
  const archived = await readFile(resolve(location.paths.slotRoot, `history/${state.runId}.json`));
  await writeFile(value.control, 'ok');
  const verified = await runs.run({ command: 'verify', cwd: value.cwd, sha: value.sha, retryCompletion: true, transport: value.transport });
  expect(verified, JSON.stringify(verified.error)).toMatchObject({ ok: true, candidateSha: value.sha,
    completion: { status: 'completed', publicationRunId: state.runId }, recovery: { reportExists: false } });
  expect(verified.completion?.attempts[0]).toEqual(state.completion?.attempts[0]);
  expect(await readFile(resolve(location.paths.slotRoot, `history/${state.runId}.json`))).toEqual(archived);
  await expect(readFile(resolve(location.paths.slotRoot, 'latest-publish.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  expect(await value.results()).toHaveLength(2);
}, 300_000);
