import { mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import { inspectGeneratedArtifacts, publishGeneratedArtifacts } from '@openge/forge-generated-artifacts/node';
import type { SnapshotManifest, SnapshotManifestInput } from '../contracts.js';
import type { SourceSnapshotBundle } from '../content-contracts.js';
import { SourceSnapshotError } from '../errors.js';
import { compareSnapshotFiles } from '../changes.js';
import { createSnapshotManifest } from '../manifest.js';
import { createTextSnapshotManifest } from '../text-manifest.js';
import { buildSnapshotReadIndex, renderSnapshotReadIndexMarkdown } from '../read-index.js';
import { collectSnapshotObjectRequirements, readSnapshotText } from '../text-reader.js';
import { parseSourceTextDetails } from '../text-format.js';
import type { PublishSourceSnapshotOptions, SourceSnapshotPublicationResult, SourceSnapshotVerificationResult, VerifyPublishedSourceSnapshotOptions } from './contracts.js';
import { acquireSourceSnapshotLock } from './lock.js';
import { readManagedBytes, readManagedText } from './managed-read.js';
import { resolveStorageLayout, type ResolvedSourceSnapshotLayout } from './layout.js';
import { assertProjectedSourceSnapshotStoreBudget, measureManagedSourceSnapshotStore } from './store-usage.js';

const SNAPSHOT_PATTERN = /^snapshot-[a-f0-9]{64}$/u;
const code=(value:unknown):string|undefined=>value instanceof Error&&'code'in value&&typeof value.code==='string'?value.code:undefined;
const isInside=(parent:string,candidate:string):boolean=>{const value=relative(parent,candidate);return value===''||(!value.startsWith('..')&&!isAbsolute(value));};
const canonicalPotential = async (input:string):Promise<string> => {
  let current=resolve(input); const missing:string[]=[];
  while(true){try{return resolve(await realpath(current),...missing);}catch(error){if(code(error)!=='ENOENT')throw error; const parent=dirname(current); if(parent===current)throw error; missing.unshift(basename(current)); current=parent;}}
};
export const assertSourceTargetSeparation = async (sourceRoot:string,targetRoot:string):Promise<void> => {
  const [source,target]=await Promise.all([canonicalPotential(sourceRoot),canonicalPotential(targetRoot)]);
  if(isInside(source,target)||isInside(target,source))throw new SourceSnapshotError('SOURCE_TARGET_OVERLAP',{sourceRoot,targetRoot});
};
const parseJson = (text:string, errorCode:'TARGET_NOT_OWNED'|'SNAPSHOT_ID_MISMATCH'):unknown => {try{return JSON.parse(text);}catch{throw new SourceSnapshotError(errorCode);}};
const ensureOwner = async (targetRoot:string,ownerId:string,projectId:string,layout:ResolvedSourceSnapshotLayout):Promise<void> => {
  if(ownerId.length===0)throw new SourceSnapshotError('INVALID_INPUT',{field:'ownerId'}); await mkdir(targetRoot,{recursive:true});
  const existing=await readManagedText(targetRoot,layout.ownerFile,false);
  if(existing!==undefined){const parsed=parseJson(existing,'TARGET_NOT_OWNED'); if(typeof parsed!=='object'||parsed===null)throw new SourceSnapshotError('TARGET_NOT_OWNED'); const value=parsed as {ownerId?:unknown;projectId?:unknown}; if(value.ownerId!==ownerId)throw new SourceSnapshotError('TARGET_OWNER_MISMATCH'); if(value.projectId!==projectId)throw new SourceSnapshotError('TARGET_PROJECT_MISMATCH'); return;}
  const allowed=new Set(layout.protectedTopLevelDirectories); const unknown=(await readdir(targetRoot,{withFileTypes:true})).filter(entry=>!(entry.isDirectory()&&allowed.has(entry.name))).map(entry=>entry.name);
  if(unknown.length>0)throw new SourceSnapshotError('TARGET_NOT_OWNED',{entries:unknown});
  await writeMutableSourceArtifacts(targetRoot,[{path:layout.ownerFile,content:`${JSON.stringify({schemaVersion:1,ownerId,projectId},null,2)}\n`}],layout);
};
export const readSourceSnapshotOwner = async (targetRoot:string,ownerId:string,layout:ResolvedSourceSnapshotLayout):Promise<{projectId:string}> => {
  const text=await readManagedText(targetRoot,layout.ownerFile,false); if(text===undefined)throw new SourceSnapshotError('TARGET_NOT_OWNED'); const parsed=parseJson(text,'TARGET_NOT_OWNED'); if(typeof parsed!=='object'||parsed===null)throw new SourceSnapshotError('TARGET_NOT_OWNED'); const value=parsed as {ownerId?:unknown;projectId?:unknown}; if(value.ownerId!==ownerId)throw new SourceSnapshotError('TARGET_OWNER_MISMATCH'); if(typeof value.projectId!=='string')throw new SourceSnapshotError('TARGET_NOT_OWNED'); return {projectId:value.projectId};
};
const assertSnapshotId=(value:string):void=>{if(!SNAPSHOT_PATTERN.test(value))throw new SourceSnapshotError('INVALID_SNAPSHOT_ID',{snapshotId:value});};
const parseEntry=(text:string):string=>{const value=text.match(/^snapshot_id:\s*(\S+)\s*$/mu)?.[1]; if(value===undefined)throw new SourceSnapshotError('INVALID_SNAPSHOT_ID'); assertSnapshotId(value); return value;};
export const readCurrentSourceSnapshotId=async(targetRoot:string,layout:ResolvedSourceSnapshotLayout,required:boolean):Promise<string|null>=>{const text=await readManagedText(targetRoot,layout.entryFile,false); if(text===undefined){if(required)throw new SourceSnapshotError('ENTRY_MISSING');return null;}return parseEntry(text);};
const snapshotPath=(snapshotId:string,name:string):string=>`snapshots/${snapshotId}/${name}`;
export const loadStoredSourceSnapshotManifest = async (targetRoot:string,snapshotId:string):Promise<SnapshotManifest> => {
  assertSnapshotId(snapshotId); const text=await readManagedText(targetRoot,snapshotPath(snapshotId,'SNAPSHOT.json'),false); if(text===undefined)throw new SourceSnapshotError('SNAPSHOT_MISSING',{snapshotId}); const parsed=parseJson(text,'SNAPSHOT_ID_MISMATCH'); if(typeof parsed!=='object'||parsed===null)throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH',{snapshotId}); const value=parsed as Partial<SnapshotManifest>; if(value.schemaVersion!==1)throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH',{snapshotId,reason:'schema-version'});
  try {const recreated=await createSnapshotManifest({projectId:value.projectId as string,policyVersion:value.policyVersion as string,publishedAt:value.publishedAt as number,repositories:value.repositories as SnapshotManifestInput['repositories'],files:value.files as SnapshotManifestInput['files'],objects:value.objects as SnapshotManifestInput['objects']}); if(value.snapshotId!==snapshotId||recreated.snapshotId!==snapshotId)throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH',{snapshotId}); return recreated;} catch(error){if(error instanceof SourceSnapshotError&&error.code==='SNAPSHOT_ID_MISMATCH')throw error; throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH',{snapshotId});}
};
const verifyObject = async(targetRoot:string,object:SnapshotManifest['objects'][number]):Promise<void>=>{const bytes=await readManagedBytes(targetRoot,object.path,false); if(bytes===undefined)throw new SourceSnapshotError('OBJECT_MISSING',{path:object.path}); const integrity=await calculateBytesIntegrity(bytes); if(integrity.sha256!==object.sha256||integrity.byteLength!==object.byteLength)throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH',{path:object.path});};
const renderEntry=(manifest:SnapshotManifest):string=>['schema_version: 1',`snapshot_id: ${manifest.snapshotId}`,'local_status: LOCAL_VERIFIED',`project_id: ${manifest.projectId}`,`published_at_ms: ${manifest.publishedAt}`,'','# Source Snapshot','',`Current snapshot: \`${manifest.snapshotId}\`.`, '',`Manifest: \`snapshots/${manifest.snapshotId}/SNAPSHOT.json\`.`,`Read index: \`snapshots/${manifest.snapshotId}/READ-INDEX.json\`.`,`Index: \`snapshots/${manifest.snapshotId}/INDEX.md\`.`, ''].join('\n');
const renderChanges=(previous:SnapshotManifest|null,current:SnapshotManifest):string=>{const changes=compareSnapshotFiles(previous,current); return `${JSON.stringify({previousSnapshotId:previous?.snapshotId??null,currentSnapshotId:current.snapshotId,...changes},null,2)}\n`;};
const generatedOptions=(layout:ResolvedSourceSnapshotLayout)=>({pathCaseSensitivity:layout.pathCaseSensitivity});
const publicationEncoder=new TextEncoder();
const bytesForWritten=(artifacts:readonly {path:string;content:string}[],written:readonly string[]):number=>{const paths=new Set(written); return artifacts.reduce((sum,artifact)=>sum+(paths.has(artifact.path)?publicationEncoder.encode(artifact.content).byteLength:0),0);};
export const writeMutableSourceArtifacts = async(targetRoot:string,artifacts:readonly {path:string;content:string}[],layout:ResolvedSourceSnapshotLayout):Promise<{written:number;unchanged:number;writtenBytes:number}>=>{const plan=defineGeneratedArtifactPlan({artifacts,retiredPaths:[]}); const result=await publishGeneratedArtifacts(targetRoot,plan,generatedOptions(layout)); if(result.diagnostics.length>0)throw new SourceSnapshotError('PUBLICATION_FAILED',{diagnostics:result.diagnostics}); return {written:result.written.length,unchanged:result.unchanged.length,writtenBytes:bytesForWritten(artifacts,result.written)};};
const writeImmutable = async(targetRoot:string,artifacts:readonly {path:string;content:string}[],layout:ResolvedSourceSnapshotLayout,collisionCode:'OBJECT_IMMUTABLE_MISMATCH'|'SNAPSHOT_COLLISION'):Promise<{written:number;unchanged:number;writtenBytes:number}>=>{const plan=defineGeneratedArtifactPlan({artifacts,retiredPaths:[]}); const inspected=await inspectGeneratedArtifacts(targetRoot,plan,generatedOptions(layout)); if(inspected.stale.length>0)throw new SourceSnapshotError(collisionCode,{paths:inspected.stale}); const result=await publishGeneratedArtifacts(targetRoot,plan,generatedOptions(layout)); if(result.diagnostics.length>0)throw new SourceSnapshotError('PUBLICATION_FAILED',{diagnostics:result.diagnostics}); return {written:result.written.length,unchanged:result.unchanged.length,writtenBytes:bytesForWritten(artifacts,result.written)};};
const validateBundle=async(bundle:SourceSnapshotBundle):Promise<void>=>{const recreated=await createTextSnapshotManifest({projectId:bundle.manifest.projectId,policyVersion:bundle.manifest.policyVersion,publishedAt:bundle.manifest.publishedAt,repositories:bundle.manifest.repositories,textPackage:bundle.textPackage}); if(recreated.snapshotId!==bundle.manifest.snapshotId)throw new SourceSnapshotError('BUNDLE_MISMATCH');};
const verificationLevelForManifest = (manifest: SnapshotManifest): 'objects' | 'text' =>
  manifest.files.every(file => parseSourceTextDetails(file.details).formatVersion === 2) ? 'text' : 'objects';
const textVerificationLimits = (manifest: SnapshotManifest) => {
  let total = 0; let maxObjectBytes = 1;
  for (const object of manifest.objects) {
    total += object.byteLength;
    if (!Number.isSafeInteger(total)) throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED',{field:'maxTotalBytes'});
    maxObjectBytes = Math.max(maxObjectBytes, object.byteLength);
  }
  const totalBytes = Math.max(1,total);
  return {maxObjectBytes,maxFileBytes:totalBytes,maxTotalBytes:totalBytes};
};
const verifyTextFiles = async (targetRoot: string, manifest: SnapshotManifest): Promise<readonly string[]> => {
  const limits=textVerificationLimits(manifest); const verified:string[]=[];
  for(const file of manifest.files){
    const requirements=collectSnapshotObjectRequirements(manifest,[file.path]); const objects=[];
    for(const object of requirements){const bytes=await readManagedBytes(targetRoot,object.path,false); if(bytes===undefined)throw new SourceSnapshotError('OBJECT_MISSING',{path:object.path}); objects.push({path:object.path,bytes});}
    await readSnapshotText(manifest,objects,file.path,limits); verified.push(file.path);
  }
  return Object.freeze(verified);
};
const loadExistingSnapshot = async(targetRoot:string,snapshotId:string):Promise<SnapshotManifest|null>=>{try{return await loadStoredSourceSnapshotManifest(targetRoot,snapshotId);}catch(error){if(error instanceof SourceSnapshotError&&error.code==='SNAPSHOT_MISSING')return null;throw error;}};
export const verifyPublishedSourceSnapshot = async(options:VerifyPublishedSourceSnapshotOptions):Promise<SourceSnapshotVerificationResult> => {
  const requestedLevel=options.level??'objects';
  if(requestedLevel!=='objects'&&requestedLevel!=='text')throw new SourceSnapshotError('INVALID_INPUT',{field:'level'});
  const layout=resolveStorageLayout(options); const owner=await readSourceSnapshotOwner(options.targetRoot,options.ownerId,layout); const requested=options.snapshotId;
  const snapshotId=requested??await readCurrentSourceSnapshotId(options.targetRoot,layout,true) as string; assertSnapshotId(snapshotId); const entryBefore=requested===undefined?snapshotId:null;
  const manifest=await loadStoredSourceSnapshotManifest(options.targetRoot,snapshotId); if(owner.projectId!==manifest.projectId)throw new SourceSnapshotError('TARGET_PROJECT_MISMATCH');
  await Promise.all(manifest.objects.map(object=>verifyObject(options.targetRoot,object)));
  let verifiedLevel:'objects'|'text'='objects'; let verifiedPaths:readonly string[]=Object.freeze([]);
  if(requestedLevel==='text'){verifiedPaths=await verifyTextFiles(options.targetRoot,manifest);verifiedLevel='text';}
  if(requested===undefined){const entryAfter=await readCurrentSourceSnapshotId(options.targetRoot,layout,true); if(entryAfter!==entryBefore)throw new SourceSnapshotError('ENTRY_MISSING',{reason:'entry-changed'});}
  return Object.freeze({status:'LOCAL_VERIFIED',snapshotId,objectCount:manifest.objects.length,sourceFileCount:manifest.files.length,requestedLevel,verifiedLevel,verifiedFileCount:verifiedPaths.length,verifiedPaths});
};
export const publishSourceSnapshot = async(bundle:SourceSnapshotBundle,options:PublishSourceSnapshotOptions):Promise<SourceSnapshotPublicationResult> => {
  await assertSourceTargetSeparation(options.sourceRoot,options.targetRoot); await validateBundle(bundle); const layout=resolveStorageLayout(options); const release=await acquireSourceSnapshotLock(options.lockPath);
  try{
    await ensureOwner(options.targetRoot,options.ownerId,bundle.manifest.projectId,layout); const current=await readCurrentSourceSnapshotId(options.targetRoot,layout,false); let previous:SnapshotManifest|null=null;
    if(current!==null){await verifyPublishedSourceSnapshot({...options,snapshotId:current,level:'objects'}); previous=await loadStoredSourceSnapshotManifest(options.targetRoot,current); if(current===bundle.manifest.snapshotId)return Object.freeze({status:'NO_CHANGES',snapshotId:current,objectCount:bundle.manifest.objects.length,sourceFileCount:bundle.manifest.files.length,writtenObjects:0,reusedObjects:bundle.manifest.objects.length,objectsReused:bundle.manifest.objects.length,bytesWritten:0});}
    const id=bundle.manifest.snapshotId; const existing=await loadExistingSnapshot(options.targetRoot,id);
    if(existing!==null){
      const level=verificationLevelForManifest(existing); await verifyPublishedSourceSnapshot({...options,snapshotId:id,level}); const entryArtifact={path:layout.entryFile,content:renderEntry(existing)};
      if(options.storeBudget!==undefined)assertProjectedSourceSnapshotStoreBudget(await measureManagedSourceSnapshotStore(options.targetRoot,layout),[entryArtifact],options.storeBudget);
      const entryResult=await writeMutableSourceArtifacts(options.targetRoot,[entryArtifact],layout); await verifyPublishedSourceSnapshot({...options,level});
      return Object.freeze({status:'LOCAL_VERIFIED',snapshotId:id,objectCount:existing.objects.length,sourceFileCount:existing.files.length,writtenObjects:0,reusedObjects:existing.objects.length,objectsReused:existing.objects.length,bytesWritten:entryResult.writtenBytes,activation:'reused'});
    }
    const objectArtifacts=bundle.textPackage.objects.map(object=>({path:object.path,content:object.content})); const readIndex=buildSnapshotReadIndex(bundle.manifest);
    const snapshotArtifacts=[{path:snapshotPath(id,'SNAPSHOT.json'),content:`${JSON.stringify(bundle.manifest,null,2)}
`},{path:snapshotPath(id,'READ-INDEX.json'),content:`${JSON.stringify(readIndex,null,2)}
`},{path:snapshotPath(id,'INDEX.md'),content:renderSnapshotReadIndexMarkdown(readIndex)},{path:snapshotPath(id,'CHANGES.json'),content:renderChanges(previous,bundle.manifest)}];
    const entryArtifact={path:layout.entryFile,content:renderEntry(bundle.manifest)};
    if(options.storeBudget!==undefined)assertProjectedSourceSnapshotStoreBudget(await measureManagedSourceSnapshotStore(options.targetRoot,layout),[...objectArtifacts,...snapshotArtifacts,entryArtifact],options.storeBudget);
    const objectResult=await writeImmutable(options.targetRoot,objectArtifacts,layout,'OBJECT_IMMUTABLE_MISMATCH');
    const snapshotResult=await writeImmutable(options.targetRoot,snapshotArtifacts,layout,'SNAPSHOT_COLLISION'); const level=verificationLevelForManifest(bundle.manifest); await verifyPublishedSourceSnapshot({...options,snapshotId:id,level}); const entryResult=await writeMutableSourceArtifacts(options.targetRoot,[entryArtifact],layout); await verifyPublishedSourceSnapshot({...options,level});
    return Object.freeze({status:'LOCAL_VERIFIED',snapshotId:id,objectCount:bundle.manifest.objects.length,sourceFileCount:bundle.manifest.files.length,writtenObjects:objectResult.written,reusedObjects:objectResult.unchanged,objectsReused:objectResult.unchanged,bytesWritten:objectResult.writtenBytes+snapshotResult.writtenBytes+entryResult.writtenBytes});
  }finally{await release();}
};
