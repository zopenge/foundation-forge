import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runSourceSnapshotCli } from '../src/cli.js';
import { addCommittedFile, createRepository } from './node-fixtures.js';

const roots:string[]=[];const now=Date.parse('2026-09-15T00:00:00.000Z');
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})))});
const makeOutside=async(prefix:string)=>{const root=await mkdtemp(join(tmpdir(),prefix));roots.push(root);return root;};
const makeConfig=async(sourceRoot:string,targetRoot:string,stateRoot:string)=>{const config=join(await makeOutside('snapshot-cli-config-'),'config.mjs');const value=`export default {
 sourceRoot: ${JSON.stringify(sourceRoot)}, projectId: 'cli-fixture', policyVersion: '1',
 policy: { textExtensions: ['.ts'], textBasenames: ['.gitignore'], sensitiveBasenamePrefixes: ['.env.'] },
 pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20, maxObjectBytesTotal: 1000000 },
 groupForPath(path) { return path.startsWith('src/') ? 'src' : 'root'; },
 targetRoot: ${JSON.stringify(targetRoot)}, lockPath: ${JSON.stringify(join(stateRoot,'lock.json'))}, ownerId: 'cli-owner',
 storage: { protectedTopLevelDirectories: ['notes'] },
 retention: { keepCount: 3, orphanGraceMs: 604800000 }
};\n`;await writeFile(config,value,'utf8');return config;};
const runtime=()=>{const stdout:string[]=[];const stderr:string[]=[];return{stdout,stderr,options:{cwd:process.cwd(),now:()=>now,stdout:(value:string)=>stdout.push(value),stderr:(value:string)=>stderr.push(value)}};};

test('plan emits a source-free JSON summary from a consumer-owned config module',async()=>{const source=await createRepository();roots.push(source);await addCommittedFile(source,'src/a.ts');await writeFile(join(source,'src','b.ts'),'export const privateSource = 42\n','utf8');const target=await makeOutside('snapshot-cli-target-');const state=await makeOutside('snapshot-cli-state-');const config=await makeConfig(source,target,state);const io=runtime();const result=await runSourceSnapshotCli(['plan','--config',config,'--json'],io.options);expect(result.exitCode).toBe(0);const parsed=JSON.parse(io.stdout.join('')) as {status:string;snapshotId:string};expect(parsed.status).toBe('READY');expect(parsed.snapshotId).toMatch(/^snapshot-/u);expect(io.stdout.join('')).not.toContain('privateSource');expect(existsSync(join(target,'00-SOURCE-SNAPSHOT.md'))).toBe(false);});

test('export verify status and prune preview work through the generic CLI',async()=>{const source=await createRepository();roots.push(source);await addCommittedFile(source,'src/a.ts');const target=await makeOutside('snapshot-cli-target-');const state=await makeOutside('snapshot-cli-state-');await mkdir(join(target,'notes'));await writeFile(join(target,'notes','keep.txt'),'keep','utf8');const config=await makeConfig(source,target,state);for(const command of [['export'],['verify'],['status'],['prune','--dry-run']] as const){const io=runtime();const result=await runSourceSnapshotCli([...command,'--config',config,'--json'],io.options);expect(result.exitCode).toBe(0);const parsed=JSON.parse(io.stdout.join('')) as {status:string};expect(['LOCAL_VERIFIED','RETENTION_STATUS','PRUNE_PREVIEW']).toContain(parsed.status);}expect(await import('node:fs/promises').then(fs=>fs.readFile(join(target,'notes','keep.txt'),'utf8'))).toBe('keep');});

test('blocked plan and export never echo secret values or publish a target',async()=>{const source=await createRepository();roots.push(source);const secret=`ghp_${'A1b'.repeat(12)}`;await writeFile(join(source,'leak.ts'),`export const token='${secret}'\n`,'utf8');const target=await makeOutside('snapshot-cli-blocked-');const state=await makeOutside('snapshot-cli-state-');const config=await makeConfig(source,target,state);for(const command of ['plan','export']){const io=runtime();const result=await runSourceSnapshotCli([command,'--config',config,'--json'],io.options);expect(result.exitCode).toBe(2);expect([...io.stdout,...io.stderr].join('')).not.toContain(secret);}expect(existsSync(join(target,'.source-snapshot-owner.json'))).toBe(false);});

test('rejects missing config, unknown flags and commands with structured failures',async()=>{for(const argv of [['plan'],['plan','--config','missing.mjs','--wat'],['unknown','--config','missing.mjs']]){const io=runtime();const result=await runSourceSnapshotCli(argv,io.options);expect(result.exitCode).toBe(1);expect(io.stderr.join('')).toMatch(/^\[/u);}});
