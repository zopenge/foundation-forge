import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { setImmediate as immediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseConfig } from '../src/contracts.js';
import { Execution } from '../src/node/execution.js';
import { BudgetMonitor } from '../src/node/managed-budget.js';
import { prebuiltApiOnce } from '../src/node/prebuilt-http.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { createPrebuiltTransport, PrebuiltVerification } from '../src/node/prebuilt-vercel.js';
import { assertVersionAliasAvailable, observeVersionAlias } from '../src/node/prebuilt-alias.js';
import { ReleaseError } from '../src/node/errors.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const boundary = vi.hoisted(() => ({ origin: '', synchronousFailure: false, onData: undefined as (() => void) | undefined,
  holdClose: undefined as 'request' | 'socket' | undefined, delayed: [] as (() => void)[] }));
// 只替换固定云端地址；请求、响应、取消和 socket 均使用本用例的真实连接。
vi.mock('node:https', async original => {
  const https = await original<typeof import('node:https')>();
  const http = await import('node:http');
  return { ...https, request: (url: URL, options: import('node:https').RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (!boundary.origin || url.origin !== 'https://api.vercel.com') throw new Error('fixture API origin required');
    if (boundary.synchronousFailure) throw new Error('fixture private network failure');
    const result = http.request(new URL(`${url.pathname}${url.search}`, boundary.origin), options, response => {
      response.on('data', () => boundary.onData?.()); callback(response);
    });
    const emit = result.emit.bind(result);
    result.emit = (event: string | symbol, ...args: unknown[]) => {
      if (event === 'close' && boundary.holdClose === 'request') { boundary.delayed.push(() => { emit(event, ...args); }); return true; }
      return emit(event, ...args);
    };
    result.on('socket', socket => {
      const emitSocket = socket.emit.bind(socket);
      socket.emit = (event: string | symbol, ...args: unknown[]) => {
        if (event === 'close' && boundary.holdClose === 'socket') { boundary.delayed.push(() => { emitSocket(event, ...args); }); return true; }
        return emitSocket(event, ...args);
      };
    });
    return result;
  } };
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(accept => { release = accept; });
  return { promise, release };
}
const project = { id: 'prj_fixture', accountId: 'team_fixture', link: null };
let server: ReturnType<typeof createServer>, sockets: Set<Socket>, pending: Promise<unknown>[];
let requests: { method: string | undefined; path: string | undefined; authorization: string | undefined }[];
let reply: (request: IncomingMessage, response: ServerResponse) => void;
let releases: (() => void)[], disposals: (() => Promise<void>)[];
let stop: AbortController;

beforeEach(async () => {
  vi.stubEnv('VERCEL_TOKEN', 'fixture-token');
  stop = new AbortController();
  sockets = new Set(); pending = []; requests = []; releases = []; disposals = [];
  boundary.holdClose = undefined; boundary.delayed = []; boundary.synchronousFailure = false; boundary.onData = undefined;
  reply = (_request, response) => { response.end(JSON.stringify(project)); };
  server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    reply(request, response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(accept => { server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address required');
  boundary.origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  stop.abort();
  vi.useRealTimers();
  for (const release of releases) release();
  boundary.holdClose = undefined;
  for (const release of boundary.delayed.splice(0)) release();
  for (const socket of sockets) socket.destroy();
  await Promise.allSettled(pending);
  await new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); });
  for (const dispose of disposals.reverse()) await dispose();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); boundary.origin = '';
});
function track<T>(operation: Promise<T>): Promise<T> { pending.push(operation); void operation.catch(() => {}); return operation; }

/** 仅把外部 CLI 边界换成真实本地 GET；前后预算扫描仍走原 BudgetMonitor。 */
class BudgetExecution extends Execution {
  networkFinished = false;
  constructor(readonly budget: BudgetMonitor, readonly releaseConfig: ReleaseConfig) { super(process.cwd(), releaseConfig, stop.signal, []); }
  override async observeRequest<T>(operation: (signal: AbortSignal) => Promise<T>, signal = this.signal): Promise<T> {
    const result = super.observeRequest(combined => this.budget.run(async observed => {
      try { return await operation(observed); } finally { this.networkFinished = true; }
    }, combined), signal);
    track(result); return result;
  }
  override run(_name: string, check: Parameters<Execution['run']>[1], _code: Parameters<Execution['run']>[2],
    _values?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    const args = check.args ?? [], index = args.indexOf('api'), path = args[index + 1];
    if (index < 0 || !path) throw new Error('only the old API CLI boundary is simulated');
    return this.observeRequest(async combined => (await prebuiltApiOnce(this.releaseConfig, path, 'GET', '', combined)).body.toString('utf8'), signal);
  }
}

describe('default prebuilt API request ownership', () => {
  it.each([
    { phase: 'before', cancel: false, response: 'ok', budgetFailure: false },
    { phase: 'after', cancel: false, response: 'ok', budgetFailure: false },
    { phase: 'after', cancel: true, response: 'ok', budgetFailure: false },
    { phase: 'after', cancel: true, response: 'status', budgetFailure: false },
    { phase: 'after', cancel: true, response: 'json', budgetFailure: false },
    { phase: 'after', cancel: true, response: 'timeout', budgetFailure: false },
    { phase: 'after', cancel: true, response: 'status', budgetFailure: true },
  ] as const)(
    'finishes host budget observation without an early network timeout or cancellation: %j', async ({ phase, cancel, response, budgetFailure }) => {
    const fixture = await managedBudgetFixture(); disposals.push(fixture.dispose);
    await mkdir(fixture.paths.checkoutRoot);
    const original = prebuiltConfiguration(), config = { ...original, limits: { ...original.limits, requestMs: 1000 } };
    const execution = new BudgetExecution(new BudgetMonitor(fixture.paths, fixture.limits), config);
    if (response === 'status') reply = (_request, outgoing) => { outgoing.writeHead(500); outgoing.end('{}'); };
    if (response === 'json') reply = (_request, outgoing) => { outgoing.end('{'); };
    if (response === 'timeout') reply = () => {};
    const entered = gate(), drained = gate(); releases.push(entered.release, drained.release);
    const sample = execution.budget.sample.bind(execution.budget); let held = false;
    vi.spyOn(execution.budget, 'sample').mockImplementation(async () => {
      if ((phase === 'before' || execution.networkFinished) && !held) { held = true; entered.release(); await drained.promise; }
      await sample(); if (held && budgetFailure) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'FIXTURE_FINAL_SAMPLE' });
    });
    const expired = new AbortController(), originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => milliseconds === 1000 ? expired.signal : originalTimeout(milliseconds));
    const caller = new AbortController(); releases.push(() => caller.abort());
    const verify = new PrebuiltVerification(config, createPrebuiltTransport(execution, config, false), caller.signal);
    let outcome: 'pending' | 'succeeded' | 'failed' = 'pending', failure: unknown;
    const result = track(verify.project().then(() => { outcome = 'succeeded'; }, error => { outcome = 'failed'; failure = error; }));
    await entered.promise; expired.abort(); if (cancel) caller.abort(); await immediate();
    expect({ outcome, failure }).toEqual({ outcome: 'pending', failure: undefined });
    drained.release(); await result;
    expect({ outcome, failure }).toEqual(cancel
      ? { outcome: 'failed', failure: expect.objectContaining({ code: budgetFailure ? 'BUDGET_EXCEEDED' : 'CANCELLED' }) }
      : { outcome: 'succeeded', failure: undefined });
    expect(requests).toEqual([{ method: 'GET', path: '/v9/projects/prj_fixture?teamId=team_fixture', authorization: 'Bearer fixture-token' }]);
    expect(execution.budget.summary()).toMatchObject({ observationsComplete: true });
    expect(execution.budget.summary().sampleCount).toBeGreaterThanOrEqual(2);
  });

  it('uses the real managed budget and guards without inventing a CLI process', async () => {
    const fixture = await managedSessionFixture({ extraConfig: { delivery: prebuiltConfiguration().delivery } });
    disposals.push(fixture.dispose); await mkdir(fixture.slot.paths.checkoutRoot);
    const session = await createManagedSession(fixture.slot, 'check', stop.signal);
    // 不允许测试误调用真实云端 CLI；缺 native GET 的原实现会在此边界失败。
    vi.spyOn(session.execution, 'run').mockImplementation(async () => { throw new Error('native API must not launch a CLI'); });
    const verify = new PrebuiltVerification(fixture.config, createPrebuiltTransport(session.execution, fixture.config, false));
    await track(verify.project()); await session.assertClosed();
    expect(session.state.processes).toEqual([]);
    expect((await fixture.slot.store.read())?.processes).toEqual([]);
    expect(session.budget.summary().sampleCount).toBeGreaterThanOrEqual(2);
    expect(requests).toHaveLength(1); expect(sockets.size).toBe(0);
    await fixture.slot.lock.release();
  });

  it('requires the protected token for default readonly prebuilt access before any network', () => {
    delete process.env.VERCEL_TOKEN;
    const config = prebuiltConfiguration(), execution = new Execution(process.cwd(), config, undefined, []);
    expect(() => createPrebuiltTransport(execution, config, false)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(requests).toEqual([]);
  });

  it.each([
    { kind: 'request', alias: false }, { kind: 'socket', alias: false },
    { kind: 'request', alias: true }, { kind: 'socket', alias: true },
  ] as const)('does not deliver a native timeout before the real close is observed: %j', async ({ kind, alias }) => {
    const config = prebuiltConfiguration(), fixture = await budgetFixture();
    const execution = new BudgetExecution(new BudgetMonitor(fixture.paths, fixture.limits), config);
    if (alias) Object.assign(config.delivery, { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } });
    boundary.holdClose = kind; reply = () => {};
    const verify = new PrebuiltVerification(config, createPrebuiltTransport(execution, config, false), stop.signal);
    let settled = false, failure: unknown;
    const operation = alias ? assertVersionAliasAvailable(verify, `fixture-${'a'.repeat(40)}.vercel.app`) : verify.project();
    const result = track(operation.catch(error => { failure = error; }).finally(() => { settled = true; }));
    await expect.poll(() => boundary.delayed.length).toBe(1);
    expect(settled).toBe(false);
    boundary.holdClose = undefined; for (const release of boundary.delayed.splice(0)) release();
    await result; expect(failure).toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } });
    expect(requests).toHaveLength(1); expect(sockets.size).toBe(0);
  });

  it.each([401, 403, 500, 302])('retains HTTP %i without retry or redirect', async status => {
    reply = (_request, response) => { response.writeHead(status, { location: 'https://example.invalid' }); response.end('{}'); };
    await expect(track(verification().project())).rejects.toMatchObject({ code: status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'VERCEL_API', details: { status } });
    expect(requests).toHaveLength(1); await expect.poll(() => sockets.size).toBe(0);
  });

  it.each([Buffer.from('{'), Buffer.from([0xc3, 0x28])])('rejects invalid JSON or UTF-8 after closing the connection: %j', async body => {
    reply = (_request, response) => { response.end(body); };
    await expect(track(verification().project())).rejects.toMatchObject({ code: 'VERCEL_API', details: { reason: 'INVALID_JSON' } });
    expect(requests).toHaveLength(1); await expect.poll(() => sockets.size).toBe(0);
  });

  it('normalizes a synchronous request failure without leaking its message or transmitting', async () => {
    boundary.synchronousFailure = true;
    const error: unknown = await track(verification().project()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_UNCONFIRMED' } });
    expect(JSON.stringify(error)).not.toContain('fixture private'); expect(requests).toEqual([]); expect(sockets.size).toBe(0);
  });

  it('rejects a received valid JSON prefix when the declared response body is incomplete', async () => {
    let observedData = false, outgoing: ServerResponse | undefined;
    boundary.onData = () => { observedData = true; outgoing?.destroy(); };
    reply = (_request, response) => {
      outgoing = response; const body = JSON.stringify(project);
      response.writeHead(200, { 'content-length': String(Buffer.byteLength(body) + 100) }); response.write(body);
    };
    await expect(track(verification().project())).rejects.toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_UNCONFIRMED' } });
    expect(observedData).toBe(true);
    expect(requests).toHaveLength(1); await expect.poll(() => sockets.size).toBe(0);
  });

  it.each([{ configured: 1_048_576, body: 70_000 }, { configured: 2048, body: 3000 }])('caps GET output at 64KiB or the smaller configured value: %j', async ({ configured, body }) => {
    reply = (_request, response) => { response.end(JSON.stringify({ ...project, payload: 'x'.repeat(body) })); };
    const base = prebuiltConfiguration(), config = { ...base, limits: { ...base.limits, maxOutputBytes: configured } };
    const outcome = await track(verification(config).project()).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    expect(outcome).toMatchObject({ ok: false, error: { code: 'VERCEL_API', details: { reason: 'OUTPUT_LIMIT' } } });
    expect(requests).toHaveLength(1); await expect.poll(() => sockets.size).toBe(0);
  });

  it('caps a stalled GET at the original thirty-second ceiling', async () => {
    const received = gate(); releases.push(received.release); reply = () => { received.release(); };
    const base = prebuiltConfiguration(), config = { ...base, limits: { ...base.limits, requestMs: 60_000 } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let failure: unknown, settled = false;
    const result = track(verification(config).project().catch(error => { failure = error; }).finally(() => { settled = true; }));
    await received.promise; await vi.advanceTimersByTimeAsync(30_000); vi.useRealTimers();
    await expect.poll(() => settled).toBe(true); await result;
    expect(failure).toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } });
    expect(requests).toHaveLength(1); await expect.poll(() => sockets.size).toBe(0);
  });

  it('uses a shorter poll deadline without changing timeout into caller cancellation', async () => {
    const received = gate(); releases.push(received.release); reply = () => { received.release(); };
    const base = prebuiltConfiguration(), config = { ...base, limits: { ...base.limits, requestMs: 1000 } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let failure: unknown;
    const result = track(verification(config).project(Date.now() + 50).catch(error => { failure = error; }));
    await received.promise; await vi.advanceTimersByTimeAsync(50); vi.useRealTimers(); await result;
    expect(failure).toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } });
    expect(requests).toHaveLength(1); await expect.poll(() => sockets.size).toBe(0);
  });

  it('rechecks the absolute poll deadline after host admission before sending any GET', async () => {
    const fixture = await budgetFixture(), config = prebuiltConfiguration();
    const execution = new BudgetExecution(new BudgetMonitor(fixture.paths, fixture.limits), config);
    const entered = gate(), proceed = gate(); releases.push(entered.release, proceed.release);
    const sample = execution.budget.sample.bind(execution.budget); let first = true;
    vi.spyOn(execution.budget, 'sample').mockImplementation(async () => {
      if (first) { first = false; entered.release(); await proceed.promise; } await sample();
    });
    const now = Date.now.bind(Date); let offset = 0; vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
    const verify = new PrebuiltVerification(config, createPrebuiltTransport(execution, config, false));
    const result = track(verify.project(Date.now() + 1000));
    await entered.promise; offset = 2000; proceed.release();
    await expect(result).rejects.toMatchObject({ code: 'DEPLOYMENT_TIMEOUT' }); expect(requests).toEqual([]);
  });

  it('cancels an in-flight GET and waits for its connection without retry', async () => {
    const controller = new AbortController(); reply = () => { controller.abort(); };
    await expect(track(verification(prebuiltConfiguration(), controller.signal).project())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(requests).toHaveLength(1); await expect.poll(() => sockets.size).toBe(0);
  });

  it('keeps a supplied transport independent of the default token and CLI', async () => {
    delete process.env.VERCEL_TOKEN;
    const config = prebuiltConfiguration(), execution = new Execution(process.cwd(), config, undefined, []), paths: string[] = [];
    const access = createPrebuiltTransport(execution, config, true, undefined, {
      api: async path => { paths.push(path); return project; }, buildInfo: async () => ({}) });
    await track(new PrebuiltVerification(config, access).project());
    expect(paths).toEqual(['/v9/projects/prj_fixture?teamId=team_fixture']); expect(requests).toEqual([]);
  });

  it.each(['DEPLOYMENT_TIMEOUT', 'AUTH_REQUIRED'] as const)('preserves the custom alias reader original %s error', async code => {
    delete process.env.VERCEL_TOKEN;
    const config = prebuiltConfiguration(); Object.assign(config.delivery, { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } });
    const failure = new ReleaseError(code), execution = new Execution(process.cwd(), config, stop.signal, []);
    const access = createPrebuiltTransport(execution, config, false, undefined, {
      api: async () => project, buildInfo: async () => ({}), versionAlias: { read: async () => { throw failure; } } });
    await expect(track(assertVersionAliasAvailable(new PrebuiltVerification(config, access, stop.signal), `fixture-${'a'.repeat(40)}.vercel.app`)))
      .rejects.toBe(failure);
    expect(requests).toEqual([]);
  });

  it.each([
    { phase: 'before', alias: false }, { phase: 'after', alias: false },
    { phase: 'before', alias: true }, { phase: 'after', alias: true },
  ] as const)('retains the real lock guard around each owned GET: %j', async ({ phase, alias }) => {
    const delivery = { ...prebuiltConfiguration().delivery, ...(alias ? { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } } : {}) };
    const fixture = await managedSessionFixture({ extraConfig: { delivery } });
    disposals.push(fixture.dispose); await mkdir(fixture.slot.paths.checkoutRoot);
    const session = await createManagedSession(fixture.slot, 'check', stop.signal);
    if (alias) reply = (_request, response) => { response.writeHead(404); response.end('{}'); };
    if (phase === 'before') await writeFile(fixture.slot.paths.lockPath, 'fixture replacement');
    else reply = (_request, response) => {
      track(writeFile(fixture.slot.paths.lockPath, 'fixture replacement').then(() => {
        if (alias) response.writeHead(404); response.end(alias ? '{}' : JSON.stringify(project));
      }));
    };
    const verify = new PrebuiltVerification(fixture.config, createPrebuiltTransport(session.execution, fixture.config, false));
    const operation: Promise<unknown> = alias ? assertVersionAliasAvailable(verify, `fixture-${'a'.repeat(40)}.vercel.app`) : verify.project();
    await expect(track(operation)).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
    expect(requests).toHaveLength(phase === 'before' ? 0 : 1); expect(session.state.processes).toEqual([]);
  });

  it('review: rechecks ownership after the initial budget sample before sending HTTP', async () => {
    const fixture = await managedSessionFixture({ extraConfig: { delivery: prebuiltConfiguration().delivery } });
    disposals.push(fixture.dispose); await mkdir(fixture.slot.paths.checkoutRoot);
    const session = await createManagedSession(fixture.slot, 'check', stop.signal), entered = gate(), proceed = gate();
    releases.push(entered.release, proceed.release);
    const sample = BudgetMonitor.prototype.sample; let first = true;
    vi.spyOn(BudgetMonitor.prototype, 'sample').mockImplementation(async function (this: BudgetMonitor, timing) {
      await sample.call(this, timing); if (first) { first = false; entered.release(); await proceed.promise; }
    });
    const verify = new PrebuiltVerification(fixture.config, createPrebuiltTransport(session.execution, fixture.config, false), stop.signal);
    const result = track(verify.project()); await entered.promise;
    await writeFile(fixture.slot.paths.lockPath, 'fixture replacement'); proceed.release();
    await expect(result).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' }); expect(requests).toEqual([]);
  });

  it('review: reserves a command before its asynchronous admission so a GET cannot overtake it', async () => {
    const fixture = await managedSessionFixture({ extraConfig: { delivery: prebuiltConfiguration().delivery } });
    disposals.push(fixture.dispose); await mkdir(fixture.slot.paths.checkoutRoot);
    const session = await createManagedSession(fixture.slot, 'check', stop.signal), entered = gate(), proceed = gate();
    releases.push(entered.release, proceed.release); const owned = fixture.slot.lock.assertOwned.bind(fixture.slot.lock); let first = true;
    vi.spyOn(fixture.slot.lock, 'assertOwned').mockImplementation(async () => {
      if (first) { first = false; entered.release(); await proceed.promise; } await owned();
    });
    const command = track(session.execution.run('reserved', { command: 'node', args: ['-e', 'process.stdout.write("done")'] }, 'COMMAND_FAILED'));
    await entered.promise;
    const verify = new PrebuiltVerification(fixture.config, createPrebuiltTransport(session.execution, fixture.config, false), stop.signal);
    await expect(track(verify.project())).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    expect(requests).toEqual([]); proceed.release(); expect(await command).toBe('done'); await session.assertClosed();
    expect(session.state.processes).toHaveLength(1); expect(session.state.processes[0]?.status).toBe('closed');
    await fixture.slot.lock.release();
  });

  it('review: keeps the absolute version alias deadline through the final GET settlement', async () => {
    const base = prebuiltConfiguration(), config = { ...base, limits: { ...base.limits, requestMs: 1000, deploymentMs: 1000 },
      delivery: { ...base.delivery, versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } } };
    const sha = 'a'.repeat(40), hostname = `fixture-${sha}.vercel.app`, now = Date.now.bind(Date); let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
    reply = (_request, response) => {
      response.end(JSON.stringify({ alias: hostname, projectId: 'prj_fixture', deploymentId: 'dpl_candidate' }));
      if (requests.length === 2) offset = 2000;
    };
    const access = createPrebuiltTransport(new Execution(process.cwd(), config, stop.signal, []), config, false);
    access.transport.buildInfo = async url => new URL(url).pathname === '/.well-known/forge-prebuilt.json'
      ? { schemaVersion: 1, sourceSha: sha, configSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64) } : { revision: sha };
    const verify = new PrebuiltVerification(config, access, stop.signal);
    await expect(track(observeVersionAlias(verify, { sourceSha: sha, configSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64), fileCount: 1, byteLength: 1,
      deploymentId: 'dpl_candidate', deploymentUrl: 'https://candidate.vercel.app', createEffect: 'accepted', promoteEffect: 'not-attempted',
      acceptanceVerified: false, promotionVerified: false, versionAlias: { hostname, effect: 'accepted', verified: false } })))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', details: { reason: 'VERSION_ALIAS_UNCONFIRMED' } });
    expect(requests).toHaveLength(2); await expect.poll(() => sockets.size).toBe(0);
  });

  it('keeps commands and checkout observations outside an active managed request', async () => {
    const fixture = await managedSessionFixture({ extraConfig: { delivery: prebuiltConfiguration().delivery } });
    disposals.push(fixture.dispose); await mkdir(fixture.slot.paths.checkoutRoot);
    const session = await createManagedSession(fixture.slot, 'check', stop.signal), received = gate(), respond = gate();
    releases.push(received.release, respond.release);
    reply = (_request, response) => { received.release(); track(respond.promise.then(() => { response.end(JSON.stringify(project)); })); };
    const verify = new PrebuiltVerification(fixture.config, createPrebuiltTransport(session.execution, fixture.config, false));
    const result = track(verify.project()); await received.promise;
    await expect(session.execution.run('forbidden', { command: 'node', args: ['-e', 'process.exit(99)'] }, 'COMMAND_FAILED')).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    await expect(session.execution.observeCheckout(async () => {})).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    await expect(verify.project()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    respond.release(); await result; expect(requests).toHaveLength(1); expect(session.state.processes).toEqual([]);
    await fixture.slot.lock.release();
  });
});

function verification(config = prebuiltConfiguration(), signal = stop.signal) {
  const execution = new Execution(process.cwd(), config, signal, []);
  return new PrebuiltVerification(config, createPrebuiltTransport(execution, config, false), signal);
}

async function budgetFixture() {
  const fixture = await managedBudgetFixture(); disposals.push(fixture.dispose); await mkdir(fixture.paths.checkoutRoot); return fixture;
}
