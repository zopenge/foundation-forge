import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseConfig, ReleaseDeployment, ReleaseReport, ReleaseTransport } from '../src/contracts.js';
import type { ExecutionContext } from '../src/node/release-context.js';
import { ReleaseError } from '../src/node/errors.js';
import { assertCandidate } from '../src/node/git.js';
import { publishCandidate } from '../src/node/publication.js';
import { VercelVerification } from '../src/node/vercel.js';
import { ScriptedExecution, type ScriptedCall, type ScriptedInput } from './helpers/scripted-execution.js';

const clock = vi.hoisted(() => ({ sleeps: [] as { milliseconds: number; signal?: AbortSignal }[] }));
// 显式替换等待边界，使用 Vitest 的全局时钟；不把假时间当作 OS 超时或进程清空证据。
vi.mock('node:timers/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: (milliseconds = 1, value?: unknown, options?: { signal?: AbortSignal }) => {
    const signal = options?.signal;
    clock.sleeps.push({ milliseconds, ...(signal ? { signal } : {}) });
    return new Promise<unknown>((accept, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); accept(value); }, milliseconds);
      signal?.addEventListener('abort', abort, { once: true });
    });
  },
}));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); clock.sleeps.length = 0; });

const sha = 'a'.repeat(40), initial = 'b'.repeat(40);
const cwd = resolve(import.meta.dirname, 'publication-component');
const projectPath = '/v9/projects/prj_fixture?teamId=team_fixture';
const listPath = `/v6/deployments?projectId=prj_fixture&target=production&sha=${sha}&limit=100&teamId=team_fixture`;
const detailPath = '/v13/deployments/dpl_fixture?withGitRepoInfo=true&teamId=team_fixture';
const aliasPath = '/v4/aliases/fixture.example.invalid?teamId=team_fixture';
const infoUrl = `https://fixture.example.invalid/build-info.json?revision=${sha}`;
const check = { command: 'node', args: ['-e', 'process.stdout.write("checked")'], timeoutMs: 10_000 };
const acceptance = { command: 'node', args: ['-e', 'if(!process.env.FORGE_RELEASE_SHA)process.exit(4)'], timeoutMs: 10_000 };
function configuration(): ReleaseConfig {
  return {
    schemaVersion: 2, source: { mode: 'workspace' },
    git: { remote: 'origin', repository: 'github.com/fixture/repository', developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [check], acceptance: [acceptance], buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 10_000, deploymentMs: 100, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 },
  };
}
function project() {
  return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository',
    repoId: 101, productionBranch: 'main', deployHooks: [], gitCredentialId: 'fixture' } };
}
function deployment() {
  return { id: 'dpl_fixture', projectId: 'prj_fixture', target: 'production', readyState: 'READY', source: 'git',
    gitSource: { type: 'github', repoId: 101, org: 'fixture', repo: 'repository', sha, ref: 'main' },
    meta: { githubCommitSha: sha, githubCommitRef: 'main' }, url: 'fixture.vercel.app' };
}
const selected: ReleaseDeployment = { id: 'dpl_fixture', projectId: 'prj_fixture', sha, state: 'READY', url: 'fixture.vercel.app' };
type TransportCall = { readonly kind: 'api' | 'buildInfo'; readonly target: string;
  readonly response?: unknown; readonly respond?: (signal: AbortSignal) => Promise<unknown> };
const api = (target: string, response: unknown): TransportCall => ({ kind: 'api', target, response });
const projectCall = (): TransportCall => api(projectPath, project());
const found = (): TransportCall[] => [projectCall(), api(listPath, { deployments: [deployment()] }), api(detailPath, deployment())];
const verified = (): TransportCall[] => [api(aliasPath, { alias: 'fixture.example.invalid', deploymentId: 'dpl_fixture', projectId: 'prj_fixture' }),
  { kind: 'buildInfo', target: infoUrl, response: { revision: sha } }];
const published = (): TransportCall[] => [projectCall(), projectCall(), projectCall(), ...found(), ...verified()];
const git = (args: readonly string[], result: string | Error = ''): ScriptedCall => ({ method: 'git', args: [args], result });
const checked = (command: 'check' | 'publish', result: string | Error = 'checked'): ScriptedCall => ({ method: 'run',
  args: ['check:0', check, 'CHECK_FAILED', { FORGE_RELEASE_COMMAND: command, FORGE_RELEASE_SHA: sha }], result });
const accepted = (command: 'publish' | 'verify', result: string | Error = ''): ScriptedCall => ({ method: 'run',
  args: ['acceptance:0', acceptance, 'ACCEPTANCE_FAILED', { FORGE_RELEASE_COMMAND: command, FORGE_RELEASE_SHA: sha,
    FORGE_RELEASE_URL: 'https://fixture.example.invalid', FORGE_RELEASE_DEPLOYMENT_ID: 'dpl_fixture' }], result });
// 期望独立列出完整 argv，不能从生产计划生成脚本，否则同时改错次序会丢失反例。
const fastForward = (): ScriptedCall[] => [
  git(['rev-parse', '--show-toplevel'], cwd),
  git(['config', '--get-regexp', '^remote\\.origin\\.(url|pushurl)$'], 'remote.origin.url https://github.com/fixture/repository.git'),
  git(['fetch', '--no-tags', 'origin', 'refs/heads/dev', 'refs/heads/main']),
  git(['ls-remote', '--refs', 'origin', 'refs/heads/dev', 'refs/heads/main'], `${initial}\trefs/heads/dev\n${initial}\trefs/heads/main`),
  git(['merge-base', '--is-ancestor', initial, sha]), git(['merge-base', '--is-ancestor', initial, sha]),
];
const push = (branch: 'dev' | 'main', result: string | Error = `*\t${sha}:refs/heads/${branch}\t[new branch]`): ScriptedCall =>
  git(['push', '--porcelain', 'origin', `${sha}:refs/heads/${branch}`], result);
const beforePush = (): ScriptedCall[] => [...fastForward(), checked('publish'), ...fastForward()];
const allCalls = (): ScriptedCall[] => [...beforePush(), push('dev'), push('main'), accepted('publish')];
const label = (input: ScriptedInput): string => input.method === 'run' ? `run:${input.args[0]}` : `${input.method}:${input.args[0].join(' ')}`;
const fetchTrace = (): string[] => fastForward().map(label);
interface Hooks {
  frozen?: () => void | Promise<void>;
  guard?: (effect?: 'developmentPush' | 'releasePush') => 'already-current' | undefined | Promise<'already-current' | undefined>;
  checkpoint?: (pending?: 'developmentPush' | 'releasePush') => void | Promise<void>;
}
function fixture(calls: readonly ScriptedCall[] = allCalls(), requests: readonly TransportCall[] = published(), signal?: AbortSignal) {
  const config = configuration(), trace: string[] = [], hooks: Hooks = {};
  const effects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  const checkpoints: { pending?: 'developmentPush' | 'releasePush'; effects: ReleaseReport['effects'] }[] = [];
  const signals: AbortSignal[] = [];
  let requestIndex = 0;
  const take = async (kind: TransportCall['kind'], target: string, requestSignal: AbortSignal): Promise<unknown> => {
    const next = requests[requestIndex];
    if (!next) throw new Error(`unexpected transport call ${String(requestIndex)}: ${kind} ${target}`);
    expect({ kind, target }).toEqual({ kind: next.kind, target: next.target });
    expect(requestSignal.aborted).toBe(false);
    trace.push(`${kind}:${target}`); signals.push(requestSignal); requestIndex++;
    return next.respond ? next.respond(requestSignal) : next.response;
  };
  const transport: ReleaseTransport = { api: (path, requestSignal) => take('api', path, requestSignal),
    buildInfo: (url, requestSignal) => take('buildInfo', url, requestSignal) };
  const execution = new ScriptedExecution({ cwd, config, calls, ...(signal ? { signal } : {}), onCall: input => { trace.push(label(input)); } });
  const context: ExecutionContext = { execution, config, sha, signal, transport, effects,
    assertFrozen: async () => { trace.push('frozen'); await hooks.frozen?.(); },
    mutationGuard: async effect => { trace.push(`guard:${effect ?? 'entry'}`); return hooks.guard?.(effect); },
    stage: async stage => { trace.push(`stage:${stage}`); },
    checkpoint: async pending => { trace.push(`checkpoint:${pending ?? 'clear'}`);
      checkpoints.push({ ...(pending ? { pending } : {}), effects: { ...effects } }); await hooks.checkpoint?.(pending); },
  };
  return { context, execution, config, trace, effects, hooks, checkpoints, signals, transport,
    assertConsumed: () => { execution.assertConsumed(); expect(requestIndex).toBe(requests.length); } };
}
const stopped = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(0);
}

describe('发布组件的显式边界', () => {
  it('拒绝未知 argv、乱序、未消费脚本及未知 transport 请求', async () => {
    const f = fixture([git(['rev-parse', 'HEAD'], sha)], []);
    await expect(f.execution.git(['push', 'origin', 'HEAD:main'])).rejects.toThrow('execution call 0');
    expect(() => f.execution.assertConsumed()).toThrow('unconsumed execution calls');
    await expect(f.execution.git(['rev-parse', 'HEAD'])).resolves.toBe(sha); f.execution.assertConsumed();
    await expect(f.execution.run('extra', check, 'CHECK_FAILED')).rejects.toThrow('unexpected execution call');
    await expect(f.transport.api('/unknown', new AbortController().signal)).rejects.toThrow('unexpected transport call');
  });
  it('完整发布按守卫、查询、UNKNOWN checkpoint、真实命令边界及验收顺序推进', async () => {
    const f = fixture();
    await expect(publishCandidate(f.context, 'publish')).resolves.toEqual(selected);
    expect(f.effects).toEqual({ developmentPush: 'pushed', releasePush: 'pushed' });
    expect(f.checkpoints).toEqual([
      { pending: 'developmentPush', effects: { developmentPush: 'unknown', releasePush: 'not-attempted' } },
      { effects: { developmentPush: 'pushed', releasePush: 'not-attempted' } },
      { pending: 'releasePush', effects: { developmentPush: 'pushed', releasePush: 'unknown' } },
      { effects: { developmentPush: 'pushed', releasePush: 'pushed' } },
    ]);
    expect(f.trace).toEqual([
      'guard:entry', ...fetchTrace(), `api:${projectPath}`, 'stage:checks', 'run:check:0', 'frozen',
      'guard:entry', ...fetchTrace(), 'stage:push-dev', 'frozen', `api:${projectPath}`, 'guard:developmentPush',
      'checkpoint:developmentPush', label(push('dev')), 'checkpoint:clear', 'stage:push-main', 'frozen',
      `api:${projectPath}`, 'guard:releasePush', 'checkpoint:releasePush', label(push('main')), 'checkpoint:clear',
      'stage:deployment', `api:${projectPath}`, `api:${listPath}`, `api:${detailPath}`, 'stage:acceptance',
      `api:${aliasPath}`, `buildInfo:${infoUrl}`, 'frozen', 'run:acceptance:0', 'frozen',
    ]); f.assertConsumed();
  });
  it('check 只运行冻结检查，不查询平台、fetch、push 或 checkpoint', async () => {
    const f = fixture([checked('check')], []);
    await expect(publishCandidate(f.context, 'check')).resolves.toBeUndefined();
    expect(f.trace).toEqual(['stage:checks', 'run:check:0', 'frozen']); expect(f.checkpoints).toEqual([]);
    expect(f.effects).toEqual({ developmentPush: 'not-attempted', releasePush: 'not-attempted' }); f.assertConsumed();
  });
  it.each(['status', 'verify'] as const)('%s 查询显式 SHA，只有 verify 独立运行验收', async command => {
    const f = fixture(command === 'verify' ? [accepted('verify')] : [], [projectCall(), ...found(), ...(command === 'verify' ? verified() : [])]);
    await expect(publishCandidate(f.context, command)).resolves.toEqual(selected);
    expect(f.effects).toEqual({ developmentPush: 'not-attempted', releasePush: 'not-attempted' }); expect(f.checkpoints).toEqual([]);
    expect(f.trace).toEqual(['stage:deployment', `api:${projectPath}`, `api:${projectPath}`, `api:${listPath}`, `api:${detailPath}`,
      ...(command === 'verify' ? ['stage:acceptance', `api:${aliasPath}`, `buildInfo:${infoUrl}`, 'frozen', 'run:acceptance:0', 'frozen'] : [])]);
    f.assertConsumed();
  });
  it('没有匹配部署时保留 DEPLOYMENT_MISSING，不能转为发布或验收', async () => {
    const f = fixture([], [projectCall(), projectCall(), api(listPath, { deployments: [] })]);
    await expect(publishCandidate(f.context, 'status')).rejects.toMatchObject({ code: 'DEPLOYMENT_MISSING' });
    expect(f.trace.at(-1)).toBe(`api:${listPath}`); f.assertConsumed();
  });
  it('守卫返回 already-current 时不启动 push，仍写清除 checkpoint 并执行验收', async () => {
    const f = fixture([...beforePush(), accepted('publish')]);
    f.hooks.guard = effect => effect ? 'already-current' : undefined;
    await expect(publishCandidate(f.context, 'publish')).resolves.toEqual(selected);
    expect(f.effects).toEqual({ developmentPush: 'already-current', releasePush: 'already-current' });
    expect(f.checkpoints).toEqual([
      { effects: { developmentPush: 'already-current', releasePush: 'not-attempted' } },
      { effects: { developmentPush: 'already-current', releasePush: 'already-current' } },
    ]); f.assertConsumed();
  });
  it('解析 Git porcelain 的已当前结果，不把执行过的 push 错记为新推送', async () => {
    const f = fixture([...beforePush(), push('dev', `=\t${sha}:refs/heads/dev\t[up to date]`), push('main'), accepted('publish')]);
    await publishCandidate(f.context, 'publish');
    expect(f.effects).toEqual({ developmentPush: 'already-current', releasePush: 'pushed' }); f.assertConsumed();
  });
  it('check 失败时原样传播 CHECK_FAILED，并停止后续冻结检查和副作用', async () => {
    const failure = new ReleaseError('CHECK_FAILED', { exitCode: 3 });
    const f = fixture([...fastForward(), checked('publish', failure)], [projectCall()]);
    await expect(publishCandidate(f.context, 'publish')).rejects.toBe(failure);
    expect(f.trace.at(-1)).toBe('run:check:0'); expect(f.checkpoints).toEqual([]);
    expect(f.effects).toEqual({ developmentPush: 'not-attempted', releasePush: 'not-attempted' }); f.assertConsumed();
  });
  it('check 改变冻结候选后保留 CANDIDATE_CHANGED，并阻止第二次 fetch', async () => {
    const f = fixture([...fastForward(), checked('publish')], [projectCall()]);
    f.hooks.frozen = () => { throw new ReleaseError('CANDIDATE_CHANGED'); };
    await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED' });
    expect(f.trace.at(-1)).toBe('frozen'); expect(f.checkpoints).toEqual([]); f.assertConsumed();
  });
  it.each(['after-check', 'after-development-push'] as const)('在 %s 失去锁时阻止下一条 push', async boundary => {
    const afterDevelopment = boundary === 'after-development-push';
    const f = fixture(afterDevelopment ? [...beforePush(), push('dev')] : [...fastForward(), checked('publish')],
      afterDevelopment ? [projectCall(), projectCall(), projectCall()] : [projectCall()]);
    let entries = 0;
    f.hooks.guard = effect => {
      if ((afterDevelopment && effect === 'releasePush') || (!afterDevelopment && !effect && ++entries === 2)) throw new ReleaseError('LOCK_OWNERSHIP');
      return undefined;
    };
    await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
    expect(f.effects).toEqual({ developmentPush: afterDevelopment ? 'pushed' : 'not-attempted', releasePush: 'not-attempted' });
    expect(f.trace.at(-1)).toBe(afterDevelopment ? 'guard:releasePush' : 'guard:entry'); f.assertConsumed();
  });
  it.each(['dev', 'main'] as const)('%s 推送丢响应或被拒绝后保持 UNKNOWN，不伪造清除 checkpoint', async branch => {
    const failure = new ReleaseError('GIT_FAILED', { reason: 'FIXTURE_RESPONSE_LOST_OR_REJECTED' });
    const f = fixture([...beforePush(), ...(branch === 'main' ? [push('dev')] : []), push(branch, failure)],
      [projectCall(), projectCall(), ...(branch === 'main' ? [projectCall()] : [])]);
    await expect(publishCandidate(f.context, 'publish')).rejects.toBe(failure);
    expect(f.effects).toEqual({ developmentPush: branch === 'dev' ? 'unknown' : 'pushed', releasePush: branch === 'dev' ? 'not-attempted' : 'unknown' });
    expect(f.checkpoints.at(-1)).toEqual({ pending: branch === 'dev' ? 'developmentPush' : 'releasePush', effects: { ...f.effects } });
    expect(f.trace.at(-1)).toBe(label(push(branch))); f.assertConsumed();
  });
  it('UNKNOWN checkpoint 失败时不能启动真实命令边界', async () => {
    const f = fixture(beforePush(), [projectCall(), projectCall()]);
    f.hooks.checkpoint = pending => { if (pending) throw new ReleaseError('IO_FAILED'); };
    await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: 'IO_FAILED' });
    expect(f.effects).toEqual({ developmentPush: 'unknown', releasePush: 'not-attempted' });
    expect(f.trace.at(-1)).toBe('checkpoint:developmentPush'); f.assertConsumed();
  });
  it.each(['project', 'repository', 'production-branch'] as const)('首个项目 %s 不匹配时尚无远端副作用', async mode => {
    const mismatch = project();
    if (mode === 'project') mismatch.id = 'prj_wrong';
    if (mode === 'repository') mismatch.link.repo = 'wrong';
    if (mode === 'production-branch') mismatch.link.productionBranch = 'dev';
    const f = fixture(fastForward(), [api(projectPath, mismatch)]);
    await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: 'DEPLOYMENT_SOURCE' });
    expect(f.effects).toEqual({ developmentPush: 'not-attempted', releasePush: 'not-attempted' }); expect(f.checkpoints).toEqual([]); f.assertConsumed();
  });
  it('在每条 push 前重新核验项目，第二条绑定失败保留已发生的 dev push', async () => {
    const f = fixture([...beforePush(), push('dev')], [projectCall(), projectCall(), api(projectPath, { ...project(), id: 'prj_changed' })]);
    await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: 'DEPLOYMENT_SOURCE' });
    expect(f.effects).toEqual({ developmentPush: 'pushed', releasePush: 'not-attempted' }); expect(f.trace.at(-1)).toBe(`api:${projectPath}`); f.assertConsumed();
  });
  it.each(['project', 'source-repo', 'source-branch', 'failed', 'alias', 'revision', 'acceptance'] as const)(
    '%s 验证失败仍保留两次已发生的 Git effects', async mode => {
      const detail = deployment();
      if (mode === 'project') detail.projectId = 'prj_wrong';
      if (mode === 'source-repo') detail.gitSource.repoId = 999;
      if (mode === 'source-branch') detail.gitSource.ref = 'dev';
      if (mode === 'failed') detail.readyState = 'ERROR';
      const requests = [projectCall(), projectCall(), projectCall(), projectCall(), api(listPath, { deployments: [deployment()] }), api(detailPath, detail)];
      const reachesAlias = ['alias', 'revision', 'acceptance'].includes(mode);
      if (reachesAlias) requests.push(api(aliasPath, { alias: 'fixture.example.invalid', projectId: 'prj_fixture', deploymentId: mode === 'alias' ? 'dpl_other' : 'dpl_fixture' }));
      if (mode === 'revision' || mode === 'acceptance') requests.push({ kind: 'buildInfo', target: infoUrl, response: { revision: mode === 'revision' ? initial : sha } });
      const failure = new ReleaseError('ACCEPTANCE_FAILED', { exitCode: 5 });
      const f = fixture([...beforePush(), push('dev'), push('main'), ...(mode === 'acceptance' ? [accepted('publish', failure)] : [])], requests);
      const expected = { project: 'DEPLOYMENT_SOURCE', 'source-repo': 'DEPLOYMENT_SOURCE', 'source-branch': 'DEPLOYMENT_SOURCE',
        failed: 'DEPLOYMENT_FAILED', alias: 'ALIAS_MISMATCH', revision: 'BUILD_REVISION', acceptance: 'ACCEPTANCE_FAILED' }[mode];
      await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: expected });
      expect(f.effects).toEqual({ developmentPush: 'pushed', releasePush: 'pushed' });
      expect(f.checkpoints.at(-1)).toEqual({ effects: { developmentPush: 'pushed', releasePush: 'pushed' } }); f.assertConsumed();
    });
  it.each(['sha', 'building'] as const)('%s 未就绪在精确 deadline 停止轮询，保留 DEPLOYMENT_TIMEOUT', async mode => {
    fakeClock();
    const requests = [projectCall(), projectCall(), projectCall()];
    for (let poll = 0; poll < 5; poll++) {
      const pending = deployment(); pending.gitSource.sha = mode === 'sha' ? initial : sha;
      pending.meta.githubCommitSha = pending.gitSource.sha; pending.readyState = 'BUILDING';
      requests.push(projectCall(), api(listPath, { deployments: [pending] }));
      if (mode === 'building') requests.push(api(detailPath, pending));
    }
    const f = fixture([...beforePush(), push('dev'), push('main')], requests);
    const result = stopped(publishCandidate(f.context, 'publish'));
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ error: { code: 'DEPLOYMENT_TIMEOUT' } });
    expect(clock.sleeps.map(sleep => sleep.milliseconds)).toEqual([20, 20, 20, 20, 20]);
    expect(Date.now()).toBe(100); expect(f.effects).toEqual({ developmentPush: 'pushed', releasePush: 'pushed' }); f.assertConsumed();
  });
  it('轮询能从 BUILDING 推进到 READY，完整请求顺序和一次等待可复核', async () => {
    fakeClock(); const building = { ...deployment(), readyState: 'BUILDING' };
    const requests = [projectCall(), projectCall(), projectCall(), projectCall(), api(listPath, { deployments: [building] }),
      api(detailPath, building), ...found(), ...verified()];
    const f = fixture(allCalls(), requests), result = stopped(publishCandidate(f.context, 'publish'));
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toEqual({ value: selected }); expect(clock.sleeps.map(sleep => sleep.milliseconds)).toEqual([20]);
    expect(f.trace.filter(entry => entry.startsWith('api:'))).toEqual(requests.filter(request => request.kind === 'api').map(request => `api:${request.target}`));
    f.assertConsumed();
  });
  it.each(['cancelled', 'request-timeout'] as const)('%s 中止进行中的请求并阻止检查和推送', async mode => {
    fakeClock();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController(); setTimeout(() => { controller.abort(new Error('component request timeout')); }, milliseconds); return controller.signal;
    });
    const controller = new AbortController();
    const f = fixture(fastForward(), [{ kind: 'api', target: projectPath, respond: signal => new Promise((_accept, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
    }) }], controller.signal);
    const result = stopped(publishCandidate(f.context, 'publish'));
    if (mode === 'cancelled') setTimeout(() => { controller.abort(); }, 25);
    await vi.advanceTimersByTimeAsync(mode === 'cancelled' ? 25 : 1000);
    expect(await result).toMatchObject({ error: { code: mode === 'cancelled' ? 'CANCELLED' : 'VERCEL_API',
      ...(mode === 'request-timeout' ? { details: { reason: 'REQUEST_TIMEOUT' } } : {}) } });
    expect(f.signals).toHaveLength(1); expect(f.signals[0]?.aborted).toBe(true);
    expect(f.effects).toEqual({ developmentPush: 'not-attempted', releasePush: 'not-attempted' }); expect(f.checkpoints).toEqual([]); f.assertConsumed();
  });
  it('verify 拒绝非 READY 结果，并且不发起 alias 或 build-info 请求', async () => {
    const f = fixture([], []), verify = new VercelVerification(f.config, f.transport, undefined);
    await expect(verify.verify({ ...selected, state: 'ERROR' })).rejects.toMatchObject({ code: 'DEPLOYMENT_FAILED' }); f.assertConsumed();
  });
});

describe('真实 Git 前的查询协议组件', () => {
  it.each(['dirty', 'branch', 'head'] as const)('候选 %s 保留原诊断，不启动真实 Git', async mode => {
    const status = `# branch.oid ${mode === 'head' ? initial : sha}\0# branch.head ${mode === 'branch' ? 'other' : 'dev'}\0${mode === 'dirty' ? '? untracked.txt\0' : ''}`;
    const f = fixture([{ method: 'streamGit', args: [['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z', '--untracked-files=all'], [0]], result: status }], []);
    await expect(assertCandidate(f.execution, f.config, mode === 'dirty' ? undefined : sha)).rejects.toMatchObject({
      code: mode === 'dirty' ? 'GIT_DIRTY' : mode === 'branch' ? 'GIT_BRANCH' : 'CANDIDATE_CHANGED' }); f.assertConsumed();
  });
  it('初始 remote 不匹配时停止在完整 config argv，不查询平台或执行 fetch', async () => {
    const f = fixture([git(['rev-parse', '--show-toplevel'], cwd),
      git(['config', '--get-regexp', '^remote\\.origin\\.(url|pushurl)$'], 'remote.origin.url https://github.com/wrong/repo.git')], []);
    await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: 'GIT_REPOSITORY' }); expect(f.checkpoints).toEqual([]); f.assertConsumed();
  });
  it('真实快进判定边界返回非祖先时保留 GIT_DIVERGED，禁止平台查询和 push', async () => {
    const calls = fastForward().slice(0, 4);
    calls.push(git(['merge-base', '--is-ancestor', initial, sha], new ReleaseError('GIT_FAILED', { exitCode: 1, termination: 'exit' })));
    const f = fixture(calls, []);
    await expect(publishCandidate(f.context, 'publish')).rejects.toMatchObject({ code: 'GIT_DIVERGED', details: { branch: 'dev' } });
    expect(f.effects).toEqual({ developmentPush: 'not-attempted', releasePush: 'not-attempted' }); f.assertConsumed();
  });
});
