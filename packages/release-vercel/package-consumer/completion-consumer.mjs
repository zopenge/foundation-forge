import { spawn } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import { validateReleaseConfig } from '@openge/forge-release-vercel/node';
import { completionFixtureToken, serveCompletionTransport } from './completion-rpc.mjs';

/** 已安装tarball的公开SDK发布失败，再由真实公开CLI恢复；只控制云I/O叶边界。 */
export async function verifyCompletionConsumer({ cwd, config, git, binary }) {
  const root = resolve(cwd, '..'), control = resolve(root, 'completion-mode.txt'), proof = resolve(root, 'production-proof.json');
  const observations = resolve(root, 'completion-observations.jsonl'), counter = resolve(root, 'completion-creates.txt');
  await copyFile(resolve(import.meta.dirname, 'completion-job.mjs'), resolve(cwd, 'completion-job.mjs'));
  const delivery = Object.fromEntries(Object.entries(config.delivery).filter(([key]) => key !== 'versionAlias'));
  const selected = validateReleaseConfig({ ...config, delivery,
    completion: { idempotent: true, jobs: [{ command: 'node', args: ['completion-job.mjs', control, proof, observations] }] },
    // 声明本夹具原有的完整部署预算，覆盖真实受管查询及 native HTTP 观察。
    limits: { ...config.limits, requestMs: 15_000, deploymentMs: config.limits.commandMs } });
  await writeFile(control, 'fail'); await writeFile(resolve(cwd, 'release.config.json'), JSON.stringify(selected));
  git('add', '--', 'release.config.json', 'completion-job.mjs'); git('commit', '-m', 'completion consumer');
  const sha = git('rev-parse', 'HEAD');
  let marker, promoted, promotions = 0, blocked = false, blockedReads = 0;
  const requests = [];
  const transport = {
    api: async path => {
      requests.push({ operation: 'api', path, at: Date.now() });
      if (requests.length > 20) requests.shift();
      if (path.startsWith('/v9/projects/')) return { id: 'prj_fixture', accountId: 'team_fixture', link: null,
        ...(promoted ? { lastAliasRequest: { type: 'promote', jobStatus: 'succeeded', toDeploymentId: promoted } } : {}) };
      if (path.startsWith('/v13/deployments/')) {
        marker ??= JSON.parse(await readFile(resolve(cwd, 'state/release-slot/checkout/state/forge-vercel-release/prebuilt/.vercel/output/static/.well-known/forge-prebuilt.json'), 'utf8'));
        if (blocked && ++blockedReads > 1) throw new Error('blocked candidate was polled again');
        return { id: 'dpl_candidate', ownerId: 'team_fixture', projectId: 'prj_fixture', target: 'production', source: 'cli', url: 'candidate.vercel.app',
          ...(blocked ? { readyState: 'BLOCKED', seatBlock: { blockCode: 'TEAM_ACCESS_REQUIRED' } } : { readyState: 'READY' }) };
      }
      if (path.startsWith('/v4/aliases/') && promoted) return { alias: 'fixture.example.invalid', projectId: 'prj_fixture', deploymentId: promoted };
      throw new Error(`unexpected fixture API ${path}`);
    },
    buildInfo: async url => {
      const target = new URL(url);
      requests.push({ operation: 'buildInfo', path: target.pathname, at: Date.now() });
      if (requests.length > 20) requests.shift();
      if (!marker) throw new Error('candidate marker missing');
      if (target.pathname === '/.well-known/forge-prebuilt.json') return marker;
      if (target.hostname === 'fixture.example.invalid') await writeFile(proof, JSON.stringify({ ...marker, deploymentId: promoted, productionUrl: 'https://fixture.example.invalid' }));
      return { revision: marker.sourceSha };
    },
    promote: async id => { if (id !== 'dpl_candidate') throw new Error('promotion target'); promotions++; promoted = id; },
  };
  const progress = async () => {
    try {
      const state = JSON.parse(await readFile(resolve(cwd, 'state/release-slot/state.json'), 'utf8'));
      return { stage: state.stage, status: state.status, commands: state.processes?.length,
        last: state.processes?.slice(-2).map(command => ({ name: command.name, status: command.status,
          identified: !!command.identity, observed: command.observationComplete })) };
    } catch (error) { return { diagnosticCode: error.code ?? 'STATE_UNREADABLE' }; }
  };
  const server = await serveCompletionTransport(transport);
  const run = mode => new Promise((accept, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', resolve(import.meta.dirname, 'completion-worker.mjs'),
      import.meta.resolve('@openge/forge-release-vercel/node'), cwd, server.endpoint, counter, mode, binary],
    { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: globalThis.AbortSignal.timeout(240_000),
      env: { ...process.env, VERCEL_TOKEN: completionFixtureToken } });
    let stdout = '', stderr = '', failure;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 2_097_152) child.kill('SIGTERM'); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      if (failure) { reject(failure); return; }
      try { accept({ code, report: JSON.parse(stdout), elapsedMs: Date.now() - started, stderr }); }
      catch (error) { reject(new Error(`completion worker: ${stderr}`, { cause: error })); }
    });
  });
  try {
    const published = await run('publish');
    if (published.code !== 1 || published.report.error?.code !== 'COMPLETION_FAILED' || published.report.completion?.status !== 'failed'
      || !published.report.prebuilt?.promotionVerified || published.report.processes?.status !== 'closed')
      throw new Error(`tarball completion failure contract: ${JSON.stringify({ error: published.report.error,
        elapsedMs: published.elapsedMs, stderr: published.stderr, requests, progress: await progress() })}`);
    const receiptPath = resolve(cwd, 'state/release-slot/latest-publish.json'), receipt = await readFile(receiptPath);
    const historyPath = resolve(cwd, 'state/release-slot/history', `${published.report.runId}.json`), history = await readFile(historyPath);
    const readsBefore = server.nativeReads, writesBefore = promotions;
    requests.length = 0; blocked = true;
    const status = await run('cli-status'), failed = status.report;
    blocked = false;
    const details = failed.error?.details, deployment = failed.deployment;
    if (status.code !== 1 || failed.ok || failed.stage !== 'deployment' || failed.error?.code !== 'DEPLOYMENT_FAILED'
      || details?.deploymentId !== 'dpl_candidate' || details.state !== 'BLOCKED' || details.providerBlockCode !== 'TEAM_ACCESS_REQUIRED'
      || details.publicationStage !== 'completion' || details.publicationStage !== published.report.stage
      || !Number.isFinite(Date.parse(details.observedAt)) || failed.runId !== published.report.runId || failed.candidateSha !== sha
      || deployment?.id !== 'dpl_candidate' || deployment.state !== 'BLOCKED' || deployment.projectId !== selected.vercel.projectId
      || deployment.url !== 'https://candidate.vercel.app' || deployment.sha !== sha || failed.steps.length !== 0
      || JSON.stringify(failed.effects) !== JSON.stringify(published.report.effects)
      || JSON.stringify(failed.prebuilt) !== JSON.stringify(published.report.prebuilt)
      || JSON.stringify(failed.completion) !== JSON.stringify(published.report.completion)
      || server.nativeReads - readsBefore !== 2 || blockedReads !== 1 || requests.length !== 2 || promotions !== writesBefore
      || !(await readFile(receiptPath)).equals(receipt) || !(await readFile(historyPath)).equals(history))
      throw new Error(`tarball CLI blocked candidate contract: ${JSON.stringify({ error: failed.error, deployment, requests, stderr: status.stderr })}`);
    await writeFile(control, 'ok');
    const readsBeforeRetry = server.nativeReads;
    const resumed = await run('cli-verify-retry'), completed = resumed.report;
    if (resumed.code !== 0 || !completed.ok || completed.candidateSha !== sha || completed.completion?.status !== 'completed'
      || completed.completion?.attempts.length !== 2 || JSON.stringify(completed.completion.attempts[0]) !== JSON.stringify(published.report.completion.attempts[0])
      || !(await readFile(receiptPath)).equals(receipt) || promotions !== 1 || Number(await readFile(counter, 'utf8')) !== 1 || server.nativeReads <= readsBeforeRetry)
      throw new Error(`tarball CLI completion retry contract: ${JSON.stringify({ error: completed.error, stage: completed.stage,
        steps: completed.steps.slice(-3), processes: completed.processes, completion: completed.completion?.status,
        elapsedMs: resumed.elapsedMs, stderr: resumed.stderr, requests, progress: await progress() })}`);
    const jobs = (await readFile(observations, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
    if (jobs.length !== 2 || jobs.some(job => job.context.sourceSha !== sha || job.context.productionUrl !== selected.vercel.productionUrl
      || job.context.deploymentId !== 'dpl_candidate' || job.context.artifactSha256 !== completed.prebuilt.artifactSha256))
      throw new Error('tarball completion exact public context');
  } finally { await server.close(); }
}
