import { spawn } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import { validateReleaseConfig } from '@openge/forge-release-vercel/node';
import { serveCompletionTransport } from './completion-rpc.mjs';

/** 已安装tarball的公开SDK发布失败，再由真实公开CLI恢复；只控制云I/O叶边界。 */
export async function verifyCompletionConsumer({ cwd, config, git, binary }) {
  const root = resolve(cwd, '..'), control = resolve(root, 'completion-mode.txt'), proof = resolve(root, 'production-proof.json');
  const observations = resolve(root, 'completion-observations.jsonl'), counter = resolve(root, 'completion-creates.txt');
  await copyFile(resolve(import.meta.dirname, 'completion-job.mjs'), resolve(cwd, 'completion-job.mjs'));
  const delivery = Object.fromEntries(Object.entries(config.delivery).filter(([key]) => key !== 'versionAlias'));
  const selected = validateReleaseConfig({ ...config, delivery,
    completion: { idempotent: true, jobs: [{ command: 'node', args: ['completion-job.mjs', control, proof, observations] }] },
    // READY观察包含真实CLI子进程；声明本夹具的完整部署预算，不沿用内存transport的1秒窗口。
    limits: { ...config.limits, requestMs: 15_000, deploymentMs: config.limits.commandMs } });
  await writeFile(control, 'fail'); await writeFile(resolve(cwd, 'release.config.json'), JSON.stringify(selected));
  git('add', '--', 'release.config.json', 'completion-job.mjs'); git('commit', '-m', 'completion consumer');
  const sha = git('rev-parse', 'HEAD');
  let marker, promoted, promotions = 0;
  const transport = {
    api: async path => {
      if (path.startsWith('/v9/projects/')) return { id: 'prj_fixture', accountId: 'team_fixture', link: null,
        ...(promoted ? { lastAliasRequest: { type: 'promote', jobStatus: 'succeeded', toDeploymentId: promoted } } : {}) };
      if (path.startsWith('/v13/deployments/')) {
        marker ??= JSON.parse(await readFile(resolve(cwd, '.tmp/release-slot/checkout/.tmp/forge-vercel-release/prebuilt/.vercel/output/static/.well-known/forge-prebuilt.json'), 'utf8'));
        return { id: 'dpl_candidate', ownerId: 'team_fixture', projectId: 'prj_fixture', target: 'production', source: 'cli', readyState: 'READY', url: 'candidate.vercel.app' };
      }
      if (path.startsWith('/v4/aliases/') && promoted) return { alias: 'fixture.example.invalid', projectId: 'prj_fixture', deploymentId: promoted };
      throw new Error(`unexpected fixture API ${path}`);
    },
    buildInfo: async url => {
      const target = new URL(url);
      if (!marker) throw new Error('candidate marker missing');
      if (target.pathname === '/.well-known/forge-prebuilt.json') return marker;
      if (target.hostname === 'fixture.example.invalid') await writeFile(proof, JSON.stringify({ ...marker, deploymentId: promoted, productionUrl: 'https://fixture.example.invalid' }));
      return { revision: marker.sourceSha };
    },
    promote: async id => { if (id !== 'dpl_candidate') throw new Error('promotion target'); promotions++; promoted = id; },
  };
  const server = await serveCompletionTransport(transport);
  const run = mode => new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'completion-worker.mjs'),
      import.meta.resolve('@openge/forge-release-vercel/node'), cwd, server.endpoint, counter, mode, binary],
    { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: globalThis.AbortSignal.timeout(240_000) });
    let stdout = '', stderr = '', failure;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 2_097_152) child.kill('SIGTERM'); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      if (failure) { reject(failure); return; }
      try { accept({ code, report: JSON.parse(stdout) }); } catch (error) { reject(new Error(`completion worker: ${stderr}`, { cause: error })); }
    });
  });
  try {
    const published = await run('publish');
    if (published.code !== 1 || published.report.error?.code !== 'COMPLETION_FAILED' || published.report.completion?.status !== 'failed'
      || !published.report.prebuilt?.promotionVerified || published.report.processes?.status !== 'closed')
      throw new Error(`tarball completion failure contract: ${JSON.stringify(published.report.error)}`);
    const receiptPath = resolve(cwd, '.tmp/release-slot/latest-publish.json'), receipt = await readFile(receiptPath);
    await writeFile(control, 'ok');
    const resumed = await run('cli-verify-retry'), completed = resumed.report;
    if (resumed.code !== 0 || !completed.ok || completed.candidateSha !== sha || completed.completion?.status !== 'completed'
      || completed.completion?.attempts.length !== 2 || JSON.stringify(completed.completion.attempts[0]) !== JSON.stringify(published.report.completion.attempts[0])
      || !(await readFile(receiptPath)).equals(receipt) || promotions !== 1 || Number(await readFile(counter, 'utf8')) !== 1)
      throw new Error(`tarball CLI completion retry contract: ${JSON.stringify({ error: completed.error, stage: completed.stage,
        steps: completed.steps.slice(-3), processes: completed.processes, completion: completed.completion?.status })}`);
    const jobs = (await readFile(observations, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
    if (jobs.length !== 2 || jobs.some(job => job.context.sourceSha !== sha || job.context.productionUrl !== selected.vercel.productionUrl
      || job.context.deploymentId !== 'dpl_candidate' || job.context.artifactSha256 !== completed.prebuilt.artifactSha256))
      throw new Error('tarball completion exact public context');
  } finally { await server.close(); }
}
