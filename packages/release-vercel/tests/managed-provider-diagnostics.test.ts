import { mkdir, readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessControlError, type OwnedProcessScopeProvider } from '@openge/forge-process-control';
import { createManagedSession } from '../src/node/managed-process.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { ReleaseError } from '../src/node/errors.js';

const observed = vi.hoisted(() => ({ cause: undefined as unknown, starts: 0, authorizations: 0, disposals: 0 }));
// 只注入Provider失败协议输入；这里的empty不代表任何真实OS作用域已停止。
vi.mock('@openge/forge-command-runner/node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-command-runner/node')>();
  const provider: OwnedProcessScopeProvider = { start: request => {
    observed.starts++;
    const closure = { scopeId: '00000000-0000-4000-8000-000000000001', binding: request.binding,
      observedAt: new Date().toISOString(), status: 'unknown' as const, reason: 'provider-failed' as const, empty: true };
    return { scopeId: closure.scopeId, rootPid: Promise.reject(observed.cause),
      completion: Promise.resolve({ exitCode: null, signal: null, closure }),
      bind: async () => { throw new Error('unexpected bind'); },
      authorize: async () => { observed.authorizations++; throw new Error('unexpected authorization'); },
      terminate: async () => closure, dispose: async () => { observed.disposals++; } };
  } };
  return { ...actual, createNodeCommandRunner: (options: Parameters<typeof actual.createNodeCommandRunner>[0]) =>
    actual.createNodeCommandRunner({ ...options, ownedScopeProvider: provider }) };
});
const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  observed.cause = undefined; observed.starts = 0; observed.authorizations = 0; observed.disposals = 0;
});

it.each([
  { reason: 'BOOT_DEADLINE' },
  { stage: 'OPEN_ROOT', nativeCode: 5 },
])('retains a classified pre-start provider cause while keeping closure unknown: %j', async details => {
  observed.cause = new ProcessControlError('PROCESS_SCOPE_UNKNOWN', { ...details, message: 'token=private-provider-secret' });
  const fixture = await managedSessionFixture(); fixtures.push(fixture);
  await mkdir(fixture.slot.paths.checkoutRoot);
  const session = await createManagedSession(fixture.slot, 'check');
  const outcome = await session.execution.run('pre-start-failure', { command: 'node', args: ['-e', 'throw Error("must not run")'] }, 'CHECK_FAILED')
    .then(value => ({ value }), (error: unknown) => ({ error }));
  if (!('error' in outcome) || !(outcome.error instanceof ReleaseError)) throw new Error('expected classified release failure');
  expect(outcome.error.code).toBe('PROCESS_STATE_UNKNOWN');
  expect(outcome.error.details).toMatchObject({ reason: 'CLOSURE_UNPROVEN', identified: false });
  expect(outcome.error.details.diagnostics).toEqual(expect.arrayContaining([{ code: 'COMMAND_SCOPE_FAILED', stage: 'provider',
    cause: { code: 'PROCESS_SCOPE_UNKNOWN', ...details } }]));
  expect(JSON.stringify(outcome)).not.toContain('private-provider-secret');
  expect(observed.starts).toBe(1); expect(observed.authorizations).toBe(0); expect(observed.disposals).toBeGreaterThan(0);
  expect(session.state.processes[0]).toMatchObject({ status: 'unknown', observationComplete: false });
  expect(session.state.processes[0]).not.toHaveProperty('terminalSha256');
  await expect(session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  expect(await readFile(fixture.slot.paths.lockPath, 'utf8')).toContain(fixture.slot.runId);
});
