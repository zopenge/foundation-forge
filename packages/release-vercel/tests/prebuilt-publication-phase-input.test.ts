import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { runRelease } from '../src/node.js';
import { Execution } from '../src/node/execution.js';
import { expect, it, vi } from 'vitest';

it('projects a prepared prebuilt phase through the public coordinator without repeating Git or installation', async () => {
  const value = await fixture();
  for (const method of ['git', 'streamGit', 'run'] as const) {
    vi.spyOn(Execution.prototype, method).mockImplementation(async () => { throw new Error('phase preparation must not execute source commands'); });
  }
  const report = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, candidateSha: value.sha,
    prebuilt: { deploymentId: 'dpl_candidate', promotionVerified: true }, processes: { status: 'closed', knownCount: 0 } });
  expect(report.steps).toEqual([]);
  expect(await value.creates()).toBe(1);
});
