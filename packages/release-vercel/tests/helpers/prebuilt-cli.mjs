import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const [counterPath, mode, ...args] = process.argv.slice(2);
const required = ['deploy', '--prebuilt', '--prod', '--skip-domain', '--no-wait', '--json', '--non-interactive', '--project', 'prj_fixture', '--scope', 'team_fixture'];
if (JSON.stringify(args) !== JSON.stringify(required)) throw new Error('unexpected prebuilt CLI invocation');
const project = JSON.parse(readFileSync('.vercel/project.json', 'utf8'));
if (project.projectId !== 'prj_fixture' || project.orgId !== 'team_fixture') throw new Error('wrong project context');
const marker = JSON.parse(readFileSync('.vercel/output/static/.well-known/forge-prebuilt.json', 'utf8'));
if (!/^[a-f0-9]{40}$/.test(marker.sourceSha) || !/^[a-f0-9]{64}$/.test(marker.artifactSha256)) throw new Error('missing frozen marker');
const count = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0;
writeFileSync(counterPath, String(count + 1));
if (mode === 'lost-response') { process.stderr.write('fixture accepted staging but lost its response'); process.exitCode = 9; }
else {
  const name = count === 0 ? 'candidate' : `candidate${count + 1}`;
  process.stdout.write(JSON.stringify({ status: 'ok', deployment: { id: `dpl_${name}`, url: `https://${name}.vercel.app`, target: 'production', readyState: 'QUEUED' } }));
}
