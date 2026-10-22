import { expect, it } from 'vitest';
import type { ReleaseConfig, ReleaseTransport } from '../src/index.js';
import { VercelVerification } from '../src/node/vercel.js';

const sha = 'a'.repeat(40);
const config: ReleaseConfig = {
  schemaVersion: 2, source: { mode: 'workspace' }, git: { remote: 'origin', repository: 'github.com/fixture/repository', developmentBranch: 'dev', releaseBranch: 'main' },
  vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
  checks: [{ command: 'node' }], acceptance: [{ command: 'node' }], buildInfo: { path: '/build-info.json', revisionField: 'revision' },
  limits: { commandMs: 1000, deploymentMs: 1000, requestMs: 1000, pollMs: 20, maxOutputBytes: 4096 },
};
const fixture = (target: ReleaseConfig = config) => {
  const project = { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
  const deployment: Record<string, unknown> = { id: 'dpl_fixture', projectId: 'prj_fixture', target: 'production', readyState: 'READY', source: 'git',
    gitSource: { type: 'github', repoId: 101, org: 'fixture', repo: 'repository', sha, ref: 'main' },
    meta: { githubCommitSha: sha, githubCommitRef: 'main' }, url: 'fixture.vercel.app' };
  const paths: string[] = [];
  const transport: ReleaseTransport = { api: async path => { paths.push(path); return path.startsWith('/v9/projects') ? project
    : path.startsWith('/v6/deployments') ? { deployments: [deployment] } : deployment; }, buildInfo: async () => ({ revision: sha }) };
  return { project, deployment, paths, verify: new VercelVerification(target, transport, undefined) };
};
it.each(['repo', 'branch'])('rejects project %s mismatch before any deployment lookup', async mode => {
  const f = fixture(); if (mode === 'repo') f.project.link.repo = 'wrong'; else f.project.link.productionBranch = 'dev';
  await expect(f.verify.project()).rejects.toMatchObject({ code: 'DEPLOYMENT_SOURCE' });
  expect(f.paths).toHaveLength(1);
});
it.each(['repoId', 'missing', 'branch'])('rejects authoritative %s mismatch even when metadata looks correct', async mode => {
  const f = fixture();
  if (mode === 'missing') delete f.deployment.gitSource;
  else Object.assign(f.deployment.gitSource as Record<string, unknown>, mode === 'repoId' ? { repoId: 999 } : { ref: 'dev' });
  await f.verify.project();
  await expect(f.verify.find(sha)).rejects.toMatchObject({ code: 'DEPLOYMENT_SOURCE' });
});
it('requests authoritative repository information and ignores metrics source', async () => {
  const f = fixture(); f.deployment.source = 'cli'; await f.verify.project();
  expect((await f.verify.find(sha))?.sha).toBe(sha);
  expect(f.paths.some(path => path.startsWith('/v13/deployments/') && path.includes('withGitRepoInfo=true'))).toBe(true);
});
it.each(['different', 'missing', 'same'])('binds custom-host repository identity when source host is %s', async mode => {
  const target = { ...config, git: { ...config.git, repository: 'enterprise-a.example.invalid:8443/fixture/repository' } };
  const f = fixture(target);
  Object.assign(f.project.link, { type: 'github-custom-host', host: 'enterprise-a.example.invalid:8443' });
  const source = f.deployment.gitSource as Record<string, unknown>;
  Object.assign(source, { type: 'github-custom-host' });
  if (mode === 'different') source.host = 'enterprise-b.example.invalid:8443';
  if (mode === 'same') source.host = 'ENTERPRISE-A.EXAMPLE.INVALID:8443';
  await f.verify.project();
  if (mode === 'same') expect((await f.verify.find(sha))?.sha).toBe(sha);
  else await expect(f.verify.find(sha)).rejects.toMatchObject({ code: 'DEPLOYMENT_SOURCE' });
});
