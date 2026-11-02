import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrebuiltReleaseState, ReleaseTransport } from '../src/contracts.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const wait = vi.hoisted(() => ({ started: undefined as (() => void) | undefined }));
// 取消发生在真实定时器等待的入口，避免用任意睡眠猜测轮询时序。
vi.mock('node:timers/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:timers/promises')>();
  return { ...original, setTimeout: (...args: Parameters<typeof original.setTimeout>) => {
    wait.started?.(); return original.setTimeout(...args);
  } };
});
import { PrebuiltVerification } from '../src/node/prebuilt-vercel.js';

afterEach(() => { wait.started = undefined; });
describe('prebuilt poll cancellation', () => {
  it.each(['ready', 'alias'])('preserves CANCELLED during the %s wait', async phase => {
    const controller = new AbortController(); let waits = 0;
    wait.started = () => { waits++; controller.abort(); };
    const state: PrebuiltReleaseState = { sourceSha: 'a'.repeat(40), configSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64),
      fileCount: 2, byteLength: 100, deploymentId: 'dpl_candidate', deploymentUrl: 'https://candidate.vercel.app',
      createEffect: 'accepted', promoteEffect: 'accepted', acceptanceVerified: true, promotionVerified: false };
    const transport: ReleaseTransport = { api: async path => path.startsWith('/v13/')
      ? { id: 'dpl_candidate', projectId: 'prj_fixture', ownerId: 'team_fixture', target: 'production', source: 'cli', readyState: 'BUILDING', url: 'candidate.vercel.app' }
      : { id: 'prj_fixture', accountId: 'team_fixture', link: null, lastAliasRequest: { type: 'promote', jobStatus: 'pending', toDeploymentId: 'dpl_candidate' } },
    buildInfo: async () => { throw new Error('polling must not reach artifact verification'); } };
    const verify = new PrebuiltVerification(prebuiltConfiguration(), transport, controller.signal);
    await expect(phase === 'ready' ? verify.ready(state) : verify.waitAlias(state)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(waits).toBe(1);
  });
});
