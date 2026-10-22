import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { runRelease } from '../../dist/node.js';

const [cwd, command, deployedSha] = process.argv.slice(2);
const sha = deployedSha ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const deployment = { id: 'dpl_fixture', projectId: 'prj_fixture', target: 'production', readyState: 'READY', source: 'git',
  gitSource: { type: 'github', repoId: 101, org: 'fixture', repo: 'repository', sha, ref: 'main' }, url: 'fixture.vercel.app' };
const transport = { api: async path => {
  if (path.startsWith('/v9/projects')) return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
  if (path.startsWith('/v6/deployments')) return { deployments: [deployment] };
  if (path.startsWith('/v13/deployments')) return deployment;
  if (path.startsWith('/v4/aliases')) return { alias: 'fixture.example.invalid', deploymentId: deployment.id, projectId: deployment.projectId };
  throw new Error('unexpected fixture API path');
}, buildInfo: async () => ({ revision: sha }) };
const report = await runRelease({ cwd, command, transport });
process.stdout.write(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1;
