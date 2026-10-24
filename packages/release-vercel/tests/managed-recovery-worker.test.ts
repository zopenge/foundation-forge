import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { runRelease } from '../src/node.js';
import type { ReleaseReport, ReleaseTransport } from '../src/contracts.js';
import type { RecordedIdentity } from '../src/node/release-context.js';
import { identityReader, processControl } from '../src/node/process-identities.js';
import { managedFixture, git } from './helpers/managed-fixture.js';
import { gitRoutingParameters } from './helpers/git-routing.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const runner = createNodeCommandRunner({ platform: process.platform === 'win32' ? 'win32' : 'posix', processControl: processControl(),
  terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 10_000, identityAcquisition: { timeoutMs: 10_000, pollIntervalMs: 20 } });
type Worker = ReturnType<typeof runner.start>;
const workers: Worker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) { await worker.terminate(); await worker.result; }
  vi.unstubAllEnvs(); for (const f of fixtures.splice(0)) await f.dispose();
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
  const worker = runner.start({ command: process.execPath, args: [resolve(import.meta.dirname, 'helpers/managed-worker.mjs'), cwd, command, ...(sha ? [sha] : [])],
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
  const worker = start(f.cwd, 'publish'), result = await worker.result;
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(1);
  const report = JSON.parse(new TextDecoder().decode(result.stdout)) as ReleaseReport;
  expect(report, `${JSON.stringify(report.error)}\n${new TextDecoder().decode(result.stderr)}`).toMatchObject({ ok: false, error: { code: 'GIT_FAILED' }, effects: { developmentPush: 'pushed', releasePush: 'unknown' }, processes: { status: 'closed' } });
  expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.initial); await waitForOwnerExit(worker);
  const recovered = await runRelease({ cwd: f.cwd, command: 'recover', transport: emptyTransport });
  expect(recovered, JSON.stringify(recovered.error)).toMatchObject({ ok: true, effects: { developmentPush: 'pushed', releasePush: 'unknown' }, processes: { status: 'closed' }, recovery: { observation: { releaseRef: { sha: f.initial, relation: 'before' } } } });
  expect(f.ref('dev')).toBe(f.sha); expect(f.ref('main')).toBe(f.initial);
  await expect(readFile(resolve(f.cwd, '.tmp/release-slot/run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  const saved = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/latest-publish.json'), 'utf8')) as { report: ReleaseReport };
  expect(saved.report.effects.releasePush).toBe('unknown'); expect(saved.report.ok).toBe(false);
  const history = JSON.parse(await readFile(resolve(f.cwd, '.tmp/release-slot/history', `${report.runId}.json`), 'utf8'));
  expect(JSON.parse(history.snapshot.publish).report).toEqual(saved.report);
});
it('keeps an accepted remote push unknown after a real coordinator crash instead of replaying it', { timeout: 720_000 }, async () => {
  const f = await fixture(), marker = resolve(f.root, 'accepted'), barrier = resolve(f.root, 'release-hook');
  const hook = resolve(f.root, 'post-receive.mjs');
  await writeFile(hook, `import fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;if(input.split('\\n').some(line=>line.endsWith(' refs/heads/main'))){fs.writeFileSync(${JSON.stringify(marker)},'accepted');const until=Date.now()+120000;while(!fs.existsSync(${JSON.stringify(barrier)})){if(Date.now()>until)process.exit(1);await new Promise(resolve=>setTimeout(resolve,100));}}`);
  await writeFile(resolve(f.remote, 'hooks/post-receive'), `#!/bin/sh\nexec node '${hook.replaceAll('\\', '/')}'\n`, { mode: 0o755 });
  const worker = start(f.cwd, 'publish'), known: RecordedIdentity[] = [];
  try {
    const deadline = Date.now() + 550_000;
    for (;;) {
      try { await readFile(marker); break; } catch { /* 等待服务端确认已更新 ref。 */ }
      if (Date.now() > deadline) throw new Error('post-receive barrier timed out');
      const early = await Promise.race([worker.result.then(result => ({ result })), new Promise<undefined>(accept => setTimeout(accept, 250))]);
      if (early) throw new Error(`coordinator exited before barrier: ${new TextDecoder().decode(early.result.stdout)}`);
    }
    expect(f.ref('main')).toBe(f.sha);
    const owner = await worker.identity; if (!owner) throw new Error('fixture coordinator identity missing');
    const all = await processControl().listProcesses({ signal: AbortSignal.timeout(10_000) });
    const pids = new Set([owner.pid]);
    for (let changed = true; changed;) { changed = false; for (const item of all) if (item.parentPid && pids.has(item.parentPid) && !pids.has(item.pid)) { pids.add(item.pid); known.push(item); changed = true; } }
    await processControl().terminateProcess({ process: owner, policy: { mode: 'force' }, signal: AbortSignal.timeout(10_000) });
    await writeFile(barrier, 'release'); await worker.result; await waitForOwnerExit(worker);
    for (const identity of known) await stopFixtureDescendant(identity);
    const before = await readFile(resolve(f.cwd, '.tmp/release-slot/run.lock'));
    const recovered = await runRelease({ cwd: f.cwd, command: 'recover', transport: emptyTransport });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN' }, effects: { releasePush: 'unknown' },
      recovery: { observation: { releaseRef: { sha: f.sha, relation: 'candidate' } } } });
    expect(await readFile(resolve(f.cwd, '.tmp/release-slot/run.lock'))).toEqual(before);
    expect(f.ref('main')).toBe(f.sha); expect(f.ref('dev')).toBe(f.sha);
  } finally {
    await writeFile(barrier, 'release');
    for (const identity of known) await stopFixtureDescendant(identity);
  }
});
