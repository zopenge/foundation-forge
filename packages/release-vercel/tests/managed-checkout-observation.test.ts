import { relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Execution } from '../src/node/execution.js';
import { assertCheckoutFrozen, prepareCheckout } from '../src/node/managed-checkout.js';
import { hasVerifiedManagedClosure } from '../src/node/managed-closure.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { parseManagedState } from '../src/node/managed-state.js';
import { ReleaseError } from '../src/node/errors.js';
import { commandComponentSession } from './helpers/component-session.js';
import { committedFixtureSource } from './helpers/committed-fixture-source.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import type { ManagedSession } from '../src/node/release-context.js';

const fixtures: { fixture: Awaited<ReturnType<typeof managedFixture>>; session?: ManagedSession;
  restore?: () => void; independentScopes?: number }[] = [];

async function prepared(signal?: AbortSignal) {
  const fixture = await managedFixture();
  const entry: (typeof fixtures)[number] = { fixture }; fixtures.push(entry);
  const source = await committedFixtureSource(fixture, fixture.sha);
  const slot = await openManagedSlot(source, fixture.execution);
  const session = await createManagedSession(slot, 'check', signal); entry.session = session;
  await prepareCheckout(commandComponentSession(session));
  return { fixture, slot, session, entry };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of fixtures.splice(0)) {
    entry.restore?.();
    if (entry.session) {
      if (entry.independentScopes !== undefined) {
        // 仅回收测试自有fixture；产品仍须保留UNKNOWN，不能用子项证明补造批次证明。
        const scopes = entry.session.state.processes.at(-1)?.observations ?? [];
        expect(scopes).toHaveLength(entry.independentScopes);
        for (const scope of scopes) expect(hasVerifiedManagedClosure(scope)).toBe(true);
      } else { await entry.session.assertStopped(); await entry.session.slot.lock.release(); }
    }
    await entry.fixture.dispose();
  }
});

it('persists one checkout observation batch while proving all five real query scopes closed', { timeout: 120_000 }, async () => {
  const { session } = await prepared(), before = session.state.processes.length;
  await assertCheckoutFrozen(session);
  const records = session.state.processes.slice(before);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: 'checkout-observation', name: 'checkout-frozen', status: 'closed', observationComplete: true });
  expect(records[0]).toHaveProperty('observations.length', 5);
  expect(records[0]).not.toHaveProperty('identity');
  expect(records[0]).not.toHaveProperty('scope');
  expect(records[0]).toHaveProperty('terminalSha256', expect.stringMatching(/^[a-f0-9]{64}$/u));
  for (const observation of records[0]?.observations ?? []) expect(hasVerifiedManagedClosure(observation)).toBe(true);
  await session.assertClosed();
  const state = structuredClone(session.state), batch = state.processes.at(-1);
  if (!batch?.observations?.[0]?.scope) throw new Error('missing batch fixture');
  batch.observations[0].scope = { ...batch.observations[0].scope, binding: `${state.runId}:${batch.observations[0].id}:00000000-0000-0000-0000-000000000000` };
  expect(hasVerifiedManagedClosure(batch)).toBe(false);
  expect(() => parseManagedState(state, session.slot.source, session.slot.slotId)).toThrow(ReleaseError);
});

it('keeps fresh management guards between queries when the source index changes', { timeout: 120_000 }, async () => {
  const { fixture, slot, session, entry } = await prepared();
  const owner = relative(fixture.cwd, slot.paths.ownershipPath).replaceAll('\\', '/');
  const original = Execution.prototype.git; let changed = false;
  entry.restore = () => { if (changed) git(fixture.cwd, 'update-index', '--force-remove', '--', owner); };
  entry.independentScopes = 1;
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
    const result = await original.call(this, args);
    if (!changed && this.cwd === slot.paths.checkoutRoot && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      git(fixture.cwd, 'add', '--force', '--', owner); changed = true;
    }
    return result;
  });
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'SLOT_PATH' });
  expect(changed).toBe(true);
  expect(session.state.processes.at(-1)).toHaveProperty('observations.length', 1);
});

it('keeps config writes and configured commands on their original identity journal', { timeout: 120_000 }, async () => {
  const { slot, session } = await prepared();
  await assertCheckoutFrozen(session);
  await session.execution.git(['config', 'fixture.observation-boundary', 'outside']);
  expect(session.state.processes.at(-1)).toMatchObject({ status: 'closed', identity: expect.any(Object), scope: expect.any(Object) });
  expect(session.state.processes.at(-1)).not.toHaveProperty('kind');
  const output = await session.execution.run('outside-batch', { command: 'node', args: ['-e',
    'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).processes.at(-1);process.stdout.write(JSON.stringify({identified:p.status==="identified"&&!!p.identity&&!!p.scope,permission:!!process.permission,inspector:require("node:inspector").url()??null}))', slot.paths.statePath] }, 'CHECK_FAILED');
  expect(JSON.parse(output)).toMatchObject({ identified: true, inspector: null });
  if (process.env.FORGE_OBSERVATION_POLICY === '1') expect(JSON.parse(output).permission).toBe(false);
  const store = await session.execution.run('package-manager-store-path', { command: 'pnpm', args: ['store', 'path'] }, 'COMMAND_FAILED');
  expect(store).not.toBe('');
});
