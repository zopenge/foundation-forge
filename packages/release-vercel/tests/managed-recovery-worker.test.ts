import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { runRelease } from '../src/node.js';
import type { ReleaseReport, ReleaseTransport } from '../src/contracts.js';
import type { RecordedIdentity } from '../src/node/release-context.js';
import { Execution } from '../src/node/execution.js';
import { identityReader, processControl } from '../src/node/process-identities.js';
import { managedFixture, git } from './helpers/managed-fixture.js';
import { gitRoutingParameters } from './helpers/git-routing.js';
import { captureFixtureAncestry } from './helpers/close-fixture-process.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const runner = createNodeCommandRunner({ platform: process.platform === 'win32' ? 'win32' : 'posix', processControl: processControl(),
  terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 10_000, identityAcquisition: { timeoutMs: 10_000, pollIntervalMs: 20 } });
type Worker = ReturnType<typeof runner.start>;
const workers: Worker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) { await worker.terminate(); await worker.result; }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) await f.dispose();
});
const fixture = async () => {
  const f = await managedFixture(); fixtures.push(f);
  const declared = 'https://github.com/fixture/repository.git';
  vi.stubEnv('GIT_CONFIG_PARAMETERS', gitRoutingParameters(f.root, f.remote, declared)); git(f.cwd, 'remote', 'set-url', 'origin', declared);
  Object.assign(f.config.git, { repository: 'github.com/fixture/repository' });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); const sha = f.commit();
  return { ...f, sha };
};
function start(cwd: string, command: string, sha?: string): Worker {
  const worker = runner.start({ command: process.execPath, args: [resolve(import.meta.dirname, 'helpers/managed-push-phase-worker.mjs'), cwd, command, ...(sha ? [sha] : [])],
    cwd, environment: { mode: 'inherit' }, output: { mode: 'capture', maxBytesPerStream: 1_048_576, overflow: 'fail' }, timeoutMs: 600_000 });
  workers.push(worker); return worker;
}
const emptyTransport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] }, buildInfo: async () => ({}) };
async function waitForOwnerExit(worker: Worker): Promise<void> {
  const identity = await worker.identity; if (!identity) throw new Error('fixture coordinator identity missing');
  for (let i = 0; i < 30; i++) {
    const value = await identityReader().readIdentity({ pid: identity.pid }); if (value.status === 'ABSENT') return;
    await new Promise(accept => setTimeout(accept, 100));
  }
  throw new Error('fixture coordinator not confirmed absent');
}
async function stopFixtureDescendant(identity: RecordedIdentity): Promise<void> {
  const read = () => identityReader().readIdentity({ pid: identity.pid, signal: AbortSignal.timeout(10_000) });
  const current = await read();
  if (current.status === 'ABSENT' || current.identity.startToken !== identity.startToken) return;
  try { await processControl().terminateProcess({ process: identity, policy: { mode: 'force' }, signal: AbortSignal.timeout(10_000) }); }
  catch (error) {
    // 监督进程也在清理这些 fixture 后代；只在原实例已消失时容忍竞争，不据此生成发布关闭证据。
    const after = await read();
    if (after.status === 'FOUND' && after.identity.startToken === identity.startToken) throw error;
  }
}
it('reconciles a real rejected main push after its coordinator exits without replaying a push', { timeout: 720_000 }, async () => {
  const f = await fixture();
  await writeFile(resolve(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then exit 1; fi\ndone\n', { mode: 0o755 });
  const worker = start(f.cwd, 'rejected-main', f.sha), result = await worker.result;
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(1);
  const report = JSON.parse(new TextDecoder().decode(result.stdout)) as ReleaseReport;
  expect(report).toMatchObject({ fixtureBoundary: 'push-phase', fixturePushes: [`${f.sha}:refs/heads/dev`, `${f.sha}:refs/heads/main`] });
  expect(report, `${JSON.stringify(report.error)}\n${new TextDecoder().decode(result.stderr)}`).toMatchObject({ ok: false, error: { code: 'GIT_FAILED' }, effects: { developmentPush: 'pushed', releasePush: 'unknown' }, processes: { status: 'closed' } });
  const phaseState = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/state.json'), 'utf8'));
  expect(phaseState).toMatchObject({ status: 'closed', pendingPush: 'releasePush' });
  expect(phaseState.processes).toHaveLength(2);
  for (const command of phaseState.processes) expect(command).toMatchObject({ name: 'git', status: 'closed',
    observationComplete: true, closure: { ownedScope: { status: 'closed', empty: true } } });
  expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.initial); await waitForOwnerExit(worker);
  const gitCalls = vi.spyOn(Execution.prototype, 'git');
  const recovered = await runRelease({ cwd: f.cwd, command: 'recover', transport: emptyTransport });
  expect(recovered, JSON.stringify(recovered.error)).toMatchObject({ ok: true, effects: { developmentPush: 'pushed', releasePush: 'unknown' }, processes: { status: 'closed' }, recovery: { observation: { releaseRef: { sha: f.initial, relation: 'before' } } } });
  expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.initial);
  expect(gitCalls.mock.calls.filter(([args]) => args[0] === 'push')).toEqual([]);
  gitCalls.mockRestore();
  await expect(readFile(resolve(f.cwd, '.tmp/release-slot/run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  const saved = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/latest-publish.json'), 'utf8')) as { report: ReleaseReport };
  expect(saved.report.effects.releasePush).toBe('unknown'); expect(saved.report.ok).toBe(false);
  const history = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/history', `${report.runId}.json`), 'utf8'));
  expect(JSON.parse(history.snapshot.publish).report).toEqual(saved.report);
});
it('keeps an accepted remote push unknown after a real coordinator crash instead of replaying it', { timeout: 720_000 }, async () => {
  const f = await fixture(), marker = resolve(f.root, 'accepted'), barrier = resolve(f.root, 'release-hook');
  const hook = resolve(f.root, 'post-receive.mjs');
  await writeFile(hook, `import fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;if(input.split('\\n').some(line=>line.endsWith(' refs/heads/main'))){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));const until=Date.now()+120000;while(!fs.existsSync(${JSON.stringify(barrier)})){if(Date.now()>until)process.exit(1);await new Promise(resolve=>setTimeout(resolve,100));}}`);
  await writeFile(resolve(f.remote, 'hooks/post-receive'), `#!/bin/sh\nexec node '${hook.replaceAll('\\', '/')}'\n`, { mode: 0o755 });
  const worker = start(f.cwd, 'accepted-main-crash', f.sha), known: RecordedIdentity[] = [];
  let fixturePhase = 'await-hook';
  try {
    const deadline = Date.now() + 550_000; let hookPid: number | undefined;
    for (;;) {
      try {
        const value: unknown = JSON.parse(await readFile(marker, 'utf8'));
        const pid: unknown = value && typeof value === 'object' ? Reflect.get(value, 'pid') : undefined;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid fixture hook identity');
        hookPid = pid; break;
      } catch (error) {
        // 完整 JSON 才能声明自有 hook PID；尚未写完或未创建时继续原有等待。
        if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (Date.now() > deadline) throw new Error('post-receive barrier timed out');
      const early = await Promise.race([worker.result.then(result => ({ result })), new Promise<undefined>(accept => setTimeout(accept, 250))]);
      if (early) throw new Error(`coordinator exited before barrier: ${new TextDecoder().decode(early.result.stdout)}`);
    }
    expect(f.ref('main')).toBe(f.sha);
    const pending = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/state.json'), 'utf8'));
    expect(pending).toMatchObject({ status: 'running', pendingPush: 'releasePush',
      effects: { developmentPush: 'pushed', releasePush: 'unknown' } });
    expect(pending.processes).toHaveLength(2);
    expect(pending.processes.at(-1)).toMatchObject({ name: 'git', status: 'identified', observationComplete: false,
      identity: { pid: expect.any(Number), startToken: expect.any(String) },
      scope: { scopeId: expect.any(String), binding: expect.any(String) } });
    const owner = await worker.identity; if (!owner) throw new Error('fixture coordinator identity missing');
    if (hookPid === undefined) throw new Error('fixture hook PID missing');
    fixturePhase = 'capture-ancestry';
    known.push(...await captureFixtureAncestry(owner, hookPid));
    fixturePhase = 'terminate-coordinator';
    await processControl().terminateProcess({ process: owner, policy: { mode: 'force' }, signal: AbortSignal.timeout(10_000) });
    fixturePhase = 'drain-coordinator';
    await writeFile(barrier, 'release'); await worker.result; await waitForOwnerExit(worker);
    fixturePhase = 'close-descendants';
    for (const identity of known) await stopFixtureDescendant(identity);
    const before = await readFile(resolve(f.cwd, '.tmp/release-slot/run.lock'));
    const beforeState = await readFile(resolve(f.cwd, '.tmp/release-slot/state.json'));
    fixturePhase = 'recover';
    const gitCalls = vi.spyOn(Execution.prototype, 'git');
    const recovered = await runRelease({ cwd: f.cwd, command: 'recover', transport: emptyTransport });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN' }, effects: { releasePush: 'unknown' },
      recovery: { observation: { releaseRef: { sha: f.sha, relation: 'candidate' } } } });
    expect(await readFile(resolve(f.cwd, '.tmp/release-slot/run.lock'))).toEqual(before);
    expect(await readFile(resolve(f.cwd, '.tmp/release-slot/state.json'))).toEqual(beforeState);
    expect(f.ref('main')).toBe(f.sha); expect(f.ref('dev')).toBe(f.sha);
    expect(gitCalls.mock.calls.filter(([args]) => args[0] === 'push')).toEqual([]);
    gitCalls.mockRestore();
  } catch (error) { throw new Error(`FIXTURE_ACCEPTED_PUSH_${fixturePhase}`, { cause: error }); }
  finally {
    await writeFile(barrier, 'release');
    for (const identity of known) await stopFixtureDescendant(identity);
  }
});
