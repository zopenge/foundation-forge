import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runSourceSnapshotCli } from '../src/node.js';
import { addCommittedFile, createRepository } from './node-fixtures.js';

const roots: string[] = [];
const now = Date.parse('2026-09-15T00:00:00.000Z');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const makeConfig = async () => {
  const source = await createRepository(); roots.push(source);
  await addCommittedFile(source, 'src/a.ts', 'export const TOP_SECRET_SOURCE_MARKER = 1\n');
  const base = await mkdtemp(join(tmpdir(), 'snapshot-cli-')); roots.push(base);
  const target = join(base, 'target'); const state = join(base, 'state');
  await Promise.all([mkdir(target), mkdir(state)]);
  const configPath = join(base, 'source-snapshot.config.mjs');
  await writeFile(configPath, `export default ${JSON.stringify({ projectId:'fixture-project',policyVersion:'1',sourceRoot:source,targetRoot:target,lockPath:join(state,'publish.lock'),ownerId:'fixture-owner',policy:{textExtensions:['.ts'],textBasenames:['.gitignore']},pack:{targetObjectBytes:4096,maxObjectBytes:8192,maxObjectCount:50,maxObjectBytesTotal:100000} })};\nexport const groupForPath = path => path.startsWith('src/') ? 'src' : 'root';\n`, 'utf8');
  return { source, base, target, configPath };
};
const runtime = (cwd: string) => { const stdout:string[]=[]; const stderr:string[]=[]; return { stdout, stderr, context:{ cwd, now:()=>now, stdout:(value:string)=>stdout.push(value), stderr:(value:string)=>stderr.push(value) } }; };
test('CLI plan/export/verify/status/prune-preview workflow emits metadata only', async () => {
  const fixture = await makeConfig();
  for (const command of ['plan','export','verify','status']) {
    const rt = runtime(fixture.base);
    const outcome = await runSourceSnapshotCli([command,'--config',fixture.configPath,'--json'], rt.context);
    expect(outcome.exitCode).toBe(0);
    const output = rt.stdout.join('');
    expect(output).not.toContain('TOP_SECRET_SOURCE_MARKER');
    expect(rt.stderr).toEqual([]);
  }
  const preview = runtime(fixture.base);
  expect((await runSourceSnapshotCli(['prune','--config',fixture.configPath,'--dry-run','--json'], preview.context)).exitCode).toBe(0);
  expect(JSON.parse(preview.stdout.join('')).status).toBe('PRUNE_PREVIEW');
});

test('CLI returns blocked exit code without exposing secret content', async () => {
  const fixture = await makeConfig();
  const secret = `ghp_${'A1b'.repeat(12)}`;
  await writeFile(join(fixture.source,'leak.ts'), `export const token='${secret}'\n`, 'utf8');
  const rt = runtime(fixture.base);
  expect((await runSourceSnapshotCli(['plan','--config',fixture.configPath,'--json'], rt.context)).exitCode).toBe(2);
  const output = rt.stdout.join('');
  expect(output).not.toContain(secret);
  expect(JSON.parse(output).secretFindingCount).toBe(1);
});
test('CLI rejects unknown options and missing config deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-cli-errors-')); roots.push(root);
  const unknown = runtime(root);
  expect((await runSourceSnapshotCli(['plan','--unknown'], unknown.context)).exitCode).toBe(1);
  expect(unknown.stderr.join('')).toContain('INVALID_INPUT');
  const missing = runtime(root);
  expect((await runSourceSnapshotCli(['plan','--config',join(root,'missing.mjs')], missing.context)).exitCode).toBe(1);
  expect(missing.stderr.length).toBe(1);
});
