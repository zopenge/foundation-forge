import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import { inspectSourceSnapshotRetention, pruneSourceSnapshots, publishSourceSnapshot, verifyPublishedSourceSnapshot } from '../src/node.js';
import { removeManagedPathConfirmed } from '../src/node/retention.js';

const roots: string[]=[]; const day=86_400_000; const start=Date.parse('2026-09-01T00:00:00.000Z');
const makeRoot=async()=>{const base=await mkdtemp(join(tmpdir(),'snapshot-retention-')); roots.push(base); const source=join(base,'source');const target=join(base,'target');const state=join(base,'state');await Promise.all([mkdir(source),mkdir(target),mkdir(state)]);return{base,source,target,lockPath:join(state,'publish.lock')}};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})))});
const makeBundle=async(version:string,publishedAt:number,content=version)=>{const staged=await stageSourceTextFile({path:'src/value.ts',group:'core',bytes:new TextEncoder().encode(`export const value = '${content}'\n`)});const textPackage=await buildSourceTextPackage([staged],{targetObjectBytes:4096,maxObjectBytes:8192,maxObjectCount:10,maxObjectBytesTotal:100_000});const manifest=await createTextSnapshotManifest({projectId:'fixture-project',policyVersion:'1',publishedAt,repositories:[{path:'',head:version.repeat(40),branch:'dev',dirty:false}],textPackage});return{manifest,textPackage}};
const publishSeries=async(roots:Awaited<ReturnType<typeof makeRoot>>,shared=false)=>{const values=[];for(const [index,version] of ['a','b','c','d'].entries()){const value=await makeBundle(version,start+index*day,shared?'same':version);values.push(value);await publishSourceSnapshot(value,{sourceRoot:roots.source,targetRoot:roots.target,lockPath:roots.lockPath,ownerId:'fixture-owner'});}return values;};

test('keeps current plus two recent snapshots and waits seven days before deleting orphan objects',async()=>{
 const dirs=await makeRoot();const values=await publishSeries(dirs);const oldest=values[0];const current=values[3];if(oldest===undefined||current===undefined)throw new Error('fixture missing');const oldestObject=oldest.textPackage.objects[0];if(oldestObject===undefined)throw new Error('object missing');
 const status=await inspectSourceSnapshotRetention({targetRoot:dirs.target,ownerId:'fixture-owner',now:start+4*day,keepCount:3,orphanGraceMs:7*day});
 expect(status.currentSnapshotId).toBe(current.manifest.snapshotId);expect(status.snapshotCount).toBe(4);expect(status.retainedSnapshotIds).toHaveLength(3);expect(status.pruneCandidateSnapshotIds).toEqual([oldest.manifest.snapshotId]);expect(status.orphanObjectCount).toBe(1);expect(status.eligibleObjectCount).toBe(0);
 const preview=await pruneSourceSnapshots({targetRoot:dirs.target,ownerId:'fixture-owner',lockPath:dirs.lockPath,now:start+4*day,keepCount:3,orphanGraceMs:7*day,dryRun:true});
 expect(preview.status).toBe('PRUNE_PREVIEW');expect(preview.removeSnapshotIds).toEqual([oldest.manifest.snapshotId]);expect(preview.removeObjectPaths).toEqual([]);expect(existsSync(join(dirs.target,'snapshots',oldest.manifest.snapshotId))).toBe(true);expect(existsSync(join(dirs.target,'.source-snapshot-gc.json'))).toBe(false);
 const first=await pruneSourceSnapshots({targetRoot:dirs.target,ownerId:'fixture-owner',lockPath:dirs.lockPath,now:start+4*day,keepCount:3,orphanGraceMs:7*day});
 expect(first.status).toBe('PRUNED');expect(first.removedSnapshotIds).toEqual([oldest.manifest.snapshotId]);expect(first.removedObjectPaths).toEqual([]);expect(existsSync(join(dirs.target,'snapshots',oldest.manifest.snapshotId))).toBe(false);expect(existsSync(join(dirs.target,...oldestObject.path.split('/')))).toBe(true);
 const gc=JSON.parse(await readFile(join(dirs.target,'.source-snapshot-gc.json'),'utf8'));expect(gc.orphanedSince[oldestObject.path]).toBe(start+4*day);
 const second=await pruneSourceSnapshots({targetRoot:dirs.target,ownerId:'fixture-owner',lockPath:dirs.lockPath,now:start+11*day,keepCount:3,orphanGraceMs:7*day});
 expect(second.removedSnapshotIds).toEqual([]);expect(second.removedObjectPaths).toEqual([oldestObject.path]);expect(existsSync(join(dirs.target,...oldestObject.path.split('/')))).toBe(false);expect((await verifyPublishedSourceSnapshot({targetRoot:dirs.target,ownerId:'fixture-owner'})).snapshotId).toBe(current.manifest.snapshotId);
});

test('never deletes an object still referenced by any retained snapshot even with stale orphan state',async()=>{
 const dirs=await makeRoot();const values=await publishSeries(dirs,true);const current=values[3];if(current===undefined)throw new Error('fixture missing');const object=current.textPackage.objects[0];if(object===undefined)throw new Error('object missing');
 await writeFile(join(dirs.target,'.source-snapshot-gc.json'),JSON.stringify({schemaVersion:1,orphanedSince:{[object.path]:start}}),'utf8');
 const result=await pruneSourceSnapshots({targetRoot:dirs.target,ownerId:'fixture-owner',lockPath:dirs.lockPath,now:start+20*day,keepCount:3,orphanGraceMs:0});
 expect(result.removedObjectPaths).toEqual([]);expect(existsSync(join(dirs.target,...object.path.split('/')))).toBe(true);const gc=JSON.parse(await readFile(join(dirs.target,'.source-snapshot-gc.json'),'utf8'));expect(gc.orphanedSince).toEqual({});
});

test('confirmed deletion fails closed when both delete mechanisms report success without removing the path',async()=>{
 const dirs=await makeRoot();await writeFile(join(dirs.target,'victim.txt'),'keep','utf8');
 await expect(removeManagedPathConfirmed(dirs.target,'victim.txt',{recursive:false,primary:async()=>{},fallback:async()=>{}})).rejects.toMatchObject({code:'DELETE_NOT_CONFIRMED'});
 expect(await readFile(join(dirs.target,'victim.txt'),'utf8')).toBe('keep');
});


test.runIf(process.platform === 'win32')('Windows fallback removes a directory when the primary deletion reports success without deleting', async()=>{
 const dirs=await makeRoot();const victim=join(dirs.target,'victim');await mkdir(victim);await writeFile(join(victim,'child.txt'),'keep','utf8');
 const removed=await removeManagedPathConfirmed(dirs.target,'victim',{recursive:true,primary:async()=>{}});
 expect(removed).toBe(true);expect(existsSync(victim)).toBe(false);
});


test('rejects corrupted GC state', async () => {
  const dirs = await makeRoot();
  const value = await makeBundle('a', start);
  await publishSourceSnapshot(value, { sourceRoot: dirs.source, targetRoot: dirs.target, lockPath: dirs.lockPath, ownerId: 'fixture-owner' });
  await writeFile(join(dirs.target, '.source-snapshot-gc.json'), '{broken', 'utf8');
  await expect(inspectSourceSnapshotRetention({ targetRoot: dirs.target, ownerId: 'fixture-owner', now: start })).rejects.toMatchObject({ code: 'GC_STATE_INVALID' });
});

test('rejects unexpected managed object entries', async () => {
  const dirs = await makeRoot();
  const value = await makeBundle('a', start);
  await publishSourceSnapshot(value, { sourceRoot: dirs.source, targetRoot: dirs.target, lockPath: dirs.lockPath, ownerId: 'fixture-owner' });
  await mkdir(join(dirs.target, 'objects', 'unexpected'));
  await expect(verifyPublishedSourceSnapshot({ targetRoot: dirs.target, ownerId: 'fixture-owner' })).resolves.toMatchObject({ status: 'LOCAL_VERIFIED' });
  await expect(inspectSourceSnapshotRetention({ targetRoot: dirs.target, ownerId: 'fixture-owner', now: start })).rejects.toMatchObject({ code: 'MANAGED_STORE_INVALID' });
});

test('default Windows fallback removes a path when the primary deletion is ineffective', async () => {
  if (process.platform !== 'win32') return;
  const dirs = await makeRoot();
  await writeFile(join(dirs.target, 'victim.txt'), 'delete-me', 'utf8');
  await expect(removeManagedPathConfirmed(dirs.target, 'victim.txt', { recursive: false, primary: async () => {} })).resolves.toBe(true);
  expect(existsSync(join(dirs.target, 'victim.txt'))).toBe(false);
});


test('inspects a single healthy snapshot before any retention history exists', async () => {
  const dirs = await makeRoot();
  const value = await makeBundle('a', start);
  await publishSourceSnapshot(value, { sourceRoot: dirs.source, targetRoot: dirs.target, lockPath: dirs.lockPath, ownerId: 'fixture-owner' });
  const status = await inspectSourceSnapshotRetention({ targetRoot: dirs.target, ownerId: 'fixture-owner', now: start });
  expect(status.snapshotCount).toBe(1);
  expect(status.currentSnapshotId).toBe(value.manifest.snapshotId);
});
