import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import { publishSourceSnapshot, verifyPublishedSourceSnapshot } from '../src/node.js';

const roots: string[] = [];
const first = <T>(values: readonly T[]): T => { const value=values[0]; if(value===undefined)throw new Error('fixture value missing'); return value; };

const makeRoot = async (prefix: string): Promise<string> => { const root=await mkdtemp(join(tmpdir(),prefix)); roots.push(root); return root; };
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})))});
const bundle = async (version='a', publishedAt=1) => {
  const staged=await stageSourceTextFile({path:'src/value.ts',group:'core',bytes:new TextEncoder().encode(`export const value = '${version}'\n`)});
  const textPackage=await buildSourceTextPackage([staged],{targetObjectBytes:4096,maxObjectBytes:8192,maxObjectCount:10,maxObjectBytesTotal:100_000});
  const manifest=await createTextSnapshotManifest({projectId:'fixture-project',policyVersion:'1',publishedAt,repositories:[{path:'',head:version.repeat(40),branch:'dev',dirty:false}],textPackage});
  return {manifest,textPackage};
};
const options = async () => {
  const base=await makeRoot('snapshot-publish-'); const source=join(base,'source'); const target=join(base,'target'); const state=join(base,'state');
  await mkdir(source); await mkdir(target); await mkdir(state);
  return {base,source,target,lockPath:join(state,'publish.lock')};
};

test('publishes immutable objects and snapshot metadata before switching the current entry', async()=>{
  const roots=await options(); await mkdir(join(roots.target,'human-notes')); await writeFile(join(roots.target,'human-notes','keep.md'),'keep','utf8');
  const value=await bundle();
  const result=await publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner',protectedTopLevelDirectories:['human-notes']});
  expect(result.status).toBe('LOCAL_VERIFIED');
  expect(result.snapshotId).toBe(value.manifest.snapshotId);
  const verified=await verifyPublishedSourceSnapshot({targetRoot:roots.target,ownerId:'fixture-owner'});
  expect(verified).toMatchObject({status:'LOCAL_VERIFIED',snapshotId:value.manifest.snapshotId,objectCount:1,sourceFileCount:1});
  const entry=await readFile(join(roots.target,'00-SOURCE-SNAPSHOT.md'),'utf8');
  expect(entry).toContain(`snapshot_id: ${value.manifest.snapshotId}`);
  const stored=JSON.parse(await readFile(join(roots.target,'snapshots',value.manifest.snapshotId,'SNAPSHOT.json'),'utf8'));
  expect(stored.snapshotId).toBe(value.manifest.snapshotId);
  expect(await readFile(join(roots.target,'human-notes','keep.md'),'utf8')).toBe('keep');
});

test('identical publication returns NO_CHANGES and does not rewrite immutable objects', async()=>{
  const roots=await options(); const value=await bundle();
  await publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'});
  const objectPath=join(roots.target,...first(value.textPackage.objects).path.split('/')); const before=(await stat(objectPath)).mtimeMs;
  const second=await publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'});
  expect(second.status).toBe('NO_CHANGES'); expect((await stat(objectPath)).mtimeMs).toBe(before);
});

test('writes generic index and changes metadata without consumer-specific semantics', async()=>{
  const roots=await options(); const first=await bundle('a',1); const second=await bundle('b',2);
  await publishSourceSnapshot(first,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'});
  await publishSourceSnapshot(second,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'});
  const changes=JSON.parse(await readFile(join(roots.target,'snapshots',second.manifest.snapshotId,'CHANGES.json'),'utf8'));
  expect(changes).toEqual({previousSnapshotId:first.manifest.snapshotId,currentSnapshotId:second.manifest.snapshotId,added:[],changed:['src/value.ts'],removed:[]});
  const index=await readFile(join(roots.target,'snapshots',second.manifest.snapshotId,'INDEX.md'),'utf8');
  expect(index).toContain('# Source Snapshot'); expect(index).toContain('src/value.ts'); expect(index).not.toMatch(/consumer-specific|product-specific|provider-specific/iu);
});

test('refuses foreign ownership, live locks, source-target overlap and unmanaged targets', async()=>{
  const roots=await options(); const value=await bundle();
  await writeFile(join(roots.target,'foreign.txt'),'x','utf8');
  await expect(publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'})).rejects.toMatchObject({code:'TARGET_NOT_OWNED'});
  await rm(join(roots.target,'foreign.txt')); await publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'});
  await writeFile(join(roots.target,'.source-snapshot-owner.json'),JSON.stringify({schemaVersion:1,ownerId:'foreign',projectId:'fixture-project'}),'utf8');
  await expect(verifyPublishedSourceSnapshot({targetRoot:roots.target,ownerId:'fixture-owner'})).rejects.toMatchObject({code:'TARGET_OWNER_MISMATCH'});
  await writeFile(join(roots.target,'.source-snapshot-owner.json'),JSON.stringify({schemaVersion:1,ownerId:'fixture-owner',projectId:'fixture-project'}),'utf8');
  await writeFile(roots.lockPath,JSON.stringify({pid:process.pid,token:'live'}),'utf8');
  await expect(publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'})).rejects.toMatchObject({code:'SNAPSHOT_LOCKED'});
  await rm(roots.lockPath);
  await expect(publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:join(roots.source,'nested'),lockPath:roots.lockPath,ownerId:'fixture-owner'})).rejects.toMatchObject({code:'SOURCE_TARGET_OVERLAP'});
});

test('verification detects object, snapshot and entry corruption', async()=>{
  const roots=await options(); const value=await bundle(); const args={targetRoot:roots.target,ownerId:'fixture-owner'};
  await publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'});
  const objectPath=join(roots.target,...first(value.textPackage.objects).path.split('/'));
  await writeFile(objectPath,'tampered','utf8');
  await expect(verifyPublishedSourceSnapshot(args)).rejects.toMatchObject({code:'OBJECT_INTEGRITY_MISMATCH'});
  await writeFile(objectPath,first(value.textPackage.objects).content,'utf8');
  const snapshotPath=join(roots.target,'snapshots',value.manifest.snapshotId,'SNAPSHOT.json'); const raw=JSON.parse(await readFile(snapshotPath,'utf8')); raw.files[0].details.lineCount=99; await writeFile(snapshotPath,JSON.stringify(raw,null,2),'utf8');
  await expect(verifyPublishedSourceSnapshot(args)).rejects.toMatchObject({code:'SNAPSHOT_ID_MISMATCH'});
  await writeFile(snapshotPath,JSON.stringify(value.manifest,null,2)+'\n','utf8');
  await writeFile(join(roots.target,'00-SOURCE-SNAPSHOT.md'),'snapshot_id: snapshot-deadbeef\n','utf8');
  await expect(verifyPublishedSourceSnapshot(args)).rejects.toMatchObject({code:'INVALID_SNAPSHOT_ID'});
});

test('refuses an existing immutable object whose content does not match its address', async()=>{
  const roots=await options(); const value=await bundle();
  await mkdir(join(roots.target,'objects')); await writeFile(join(roots.target,'.source-snapshot-owner.json'),JSON.stringify({schemaVersion:1,ownerId:'fixture-owner',projectId:'fixture-project'}),'utf8');
  await writeFile(join(roots.target,...first(value.textPackage.objects).path.split('/')),'wrong','utf8');
  await expect(publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'})).rejects.toMatchObject({code:'OBJECT_IMMUTABLE_MISMATCH'});
});
