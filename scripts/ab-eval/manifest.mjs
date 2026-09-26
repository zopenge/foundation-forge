import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { validateToolContractShape } from './tool-contract.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const fail=(code,detail)=>Object.assign(new Error(detail??code),{code});
const safeId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value);
const safeRelative=value=>typeof value==='string'&&value.length>0
  &&!value.includes('\\')&&!value.includes(':')&&!value.startsWith('/')
  &&value.split('/').every(segment=>segment.length>0&&segment!=='.'&&segment!=='..');
const inside=(base,path)=>path===base||path.startsWith(base+sep);
const assertNpmTarball=bytes=>{
  let tar;
  try{tar=gunzipSync(bytes,{maxOutputLength:128*1024*1024});}
  catch{throw fail('CANDIDATE_TARBALL_INVALID');}
  let found=false;let cursor=0;
  while(cursor+512<=tar.length){
    const header=tar.subarray(cursor,cursor+512);
    if(header.every(byte=>byte===0))break;
    const name=header.toString('utf8',0,100).replace(/\0.*$/u,'');
    const sizeText=header.toString('ascii',124,136).replace(/\0.*$/u,'').trim();
    const size=Number.parseInt(sizeText,8);
    if(header.toString('ascii',257,262)!=='ustar'
      ||!Number.isSafeInteger(size)||size<0||cursor+512+size>tar.length)
      throw fail('CANDIDATE_TARBALL_INVALID');
    if(name==='package/package.json'&&size>0)found=true;
    cursor+=512+Math.ceil(size/512)*512;
  }
  if(!found)throw fail('CANDIDATE_TARBALL_INVALID');
};

export const resolvePackPath=(base,relativePath)=>{
  if(!safeRelative(relativePath))throw fail('PACK_PATH_INVALID',relativePath);
  const path=resolve(base,...relativePath.split('/'));
  if(!inside(resolve(base),path))throw fail('PACK_PATH_INVALID',relativePath);
  return path;
};

const validateShape=manifest=>{
  const pathValues=[manifest?.candidate,manifest?.configs?.A,manifest?.configs?.C,
    ...(Array.isArray(manifest?.tasks)?manifest.tasks.flatMap(task=>[
      task?.fixture,task?.setup,task?.publicVerifier,task?.hiddenVerifier]):[])];
  for(const value of pathValues){
    if(typeof value==='string'&&!safeRelative(value))throw fail('PACK_PATH_INVALID',value);
  }
  if(manifest?.schemaVersion!==1||!safeId(manifest.id)
    ||!safeRelative(manifest.candidate)
    ||manifest.client?.kind!=='opencode'
    ||![manifest.client.version,manifest.client.model,manifest.client.variant,
      manifest.client.agent].every(x=>typeof x==='string'&&x.length>0)
    ||!safeRelative(manifest.configs?.A)||!safeRelative(manifest.configs?.C)
    ||!Array.isArray(manifest.tasks)||manifest.tasks.length===0
    ||!Array.isArray(manifest.pairs)||manifest.pairs.length===0
    ||!Number.isInteger(manifest.concurrency)||manifest.concurrency<1
    ||manifest.concurrency>manifest.pairs.length
    ||!Number.isInteger(manifest.armTimeoutMs)||manifest.armTimeoutMs<1000
    ||manifest.armTimeoutMs>3600000)
    throw fail('PACK_MANIFEST_INVALID');
  const taskIds=new Set();
  for(const task of manifest.tasks){
    if(!safeId(task.id)||taskIds.has(task.id)||!safeRelative(task.fixture)
      ||(task.setup!==undefined&&!safeRelative(task.setup))
      ||!safeRelative(task.publicVerifier)||!safeRelative(task.hiddenVerifier)
      ||typeof task.prompt!=='string'||task.prompt.length===0)
      throw fail('PACK_MANIFEST_INVALID');
    taskIds.add(task.id);
  }
  const pairIds=new Set();
  for(const pair of manifest.pairs){
    if(!safeId(pair.id)||pairIds.has(pair.id)||!taskIds.has(pair.taskId)
      ||!['AC','CA'].includes(pair.order))throw fail('PACK_MANIFEST_INVALID');
    pairIds.add(pair.id);
  }
  for(const arm of ['A','C']){
    const tools=manifest.allowedTools?.[arm];
    if(!Array.isArray(tools)||tools.length===0
      ||tools.some(x=>typeof x!=='string'||x.length===0)
      ||new Set(tools).size!==tools.length)throw fail('PACK_MANIFEST_INVALID');
  }
  validateToolContractShape(manifest);
};

const walkFiles=async(base,excluded=new Set())=>{
  const files=[];
  const walk=async(rel='')=>{
    const dir=rel?resolvePackPath(base,rel):base;
    for(const entry of (await readdir(dir,{withFileTypes:true}))
      .sort((a,b)=>a.name.localeCompare(b.name))){
      const next=rel?`${rel}/${entry.name}`:entry.name;
      if(excluded.has(next))continue;
      const path=resolvePackPath(base,next);
      const info=await lstat(path);
      if(info.isSymbolicLink())throw fail('PACK_SYMLINK_FORBIDDEN',next);
      if(info.isDirectory())await walk(next);
      else if(info.isFile())files.push(next);
      else throw fail('PACK_FILE_TYPE_INVALID',next);
    }
  };
  await walk();
  return files;
};

const referencedFiles=manifest=>[
  manifest.candidate,manifest.configs.A,manifest.configs.C,
  ...manifest.tasks.flatMap(task=>[task.setup,task.publicVerifier,
    task.hiddenVerifier].filter(Boolean)),
];
const validateReferences=(manifest,files)=>{
  for(const path of referencedFiles(manifest)){
    if(!Object.hasOwn(files,path))throw fail('PACK_REFERENCE_MISSING',path);
  }
  for(const task of manifest.tasks){
    if(!Object.keys(files).some(path=>path.startsWith(task.fixture+'/')))
      throw fail('PACK_REFERENCE_MISSING',task.fixture);
  }
};

export const freezePack=async({draftPath,outputPath})=>{
  const draft=JSON.parse(await readFile(draftPath,'utf8'));
  validateShape(draft);
  const base=resolve(dirname(draftPath));
  const output=resolve(outputPath);
  if(!inside(base,output))throw fail('PACK_OUTPUT_OUTSIDE_SOURCE');
  const excluded=new Set([relative(base,output).replaceAll('\\','/')]);
  const paths=await walkFiles(base,excluded);
  const files={};
  for(const path of paths)files[path]=sha(await readFile(resolvePackPath(base,path)));
  validateReferences(draft,files);
  assertNpmTarball(await readFile(resolvePackPath(base,draft.candidate)));
  const manifest={...draft,files};
  await writeFile(output,`${JSON.stringify(manifest,null,2)}\n`,{encoding:'utf8',flag:'wx'});
  return manifest;
};

export const validatePack=async manifestPath=>{
  const bytes=await readFile(manifestPath);
  const manifest=JSON.parse(bytes.toString('utf8'));
  validateShape(manifest);
  const base=resolve(dirname(manifestPath));
  const entries=Object.entries(manifest.files??{});
  if(entries.length===0)throw fail('PACK_MANIFEST_INVALID');
  validateReferences(manifest,manifest.files);
  const listed=new Set(entries.map(([path])=>path));
  const manifestRelative=relative(base,resolve(manifestPath)).replaceAll('\\','/');
  for(const path of await walkFiles(base,new Set([manifestRelative]))){
    if(!listed.has(path))throw fail('PACK_SOURCE_DRIFT',path);
  }
  for(const [path,expected] of entries){
    if(!/^[A-F0-9]{64}$/u.test(expected))throw fail('PACK_MANIFEST_INVALID');
    const absolute=resolvePackPath(base,path);
    const info=await lstat(absolute);
    if(!info.isFile()||info.isSymbolicLink())throw fail('PACK_FILE_TYPE_INVALID',path);
    if(sha(await readFile(absolute))!==expected)throw fail('PACK_SOURCE_DRIFT',path);
  }
  assertNpmTarball(await readFile(resolvePackPath(base,manifest.candidate)));
  return {manifest,base,manifestSha256:sha(bytes)};
};

export const slicePack=async({manifestPath,outputDir,id,pairIds})=>{
  const {manifest,base,manifestSha256}=await validatePack(manifestPath);
  const target=resolve(outputDir);
  const temporaryRoot=resolve(import.meta.dirname,'../../.tmp');
  if(!safeId(id)||!Array.isArray(pairIds)||pairIds.length===0
    ||new Set(pairIds).size!==pairIds.length
    ||!inside(temporaryRoot,target)||target===temporaryRoot
    ||inside(base,target)||inside(target,base))throw fail('PACK_SLICE_ARGUMENT_INVALID');
  const wanted=new Set(pairIds);
  const pairs=manifest.pairs.filter(pair=>wanted.has(pair.id));
  if(pairs.length!==pairIds.length)throw fail('PACK_SLICE_PAIR_UNKNOWN');
  const taskIds=new Set(pairs.map(pair=>pair.taskId));
  await mkdir(dirname(target),{recursive:true});
  await mkdir(target,{recursive:false});
  for(const path of Object.keys(manifest.files)){
    if(path==='draft.json')continue;
    const destination=resolvePackPath(target,path);
    await mkdir(dirname(destination),{recursive:true});
    await cp(resolvePackPath(base,path),destination,
      {force:false,errorOnExist:true});
  }
  const draft={...manifest,id,pairs,
    concurrency:Math.min(manifest.concurrency,pairs.length),
    tasks:manifest.tasks.filter(task=>taskIds.has(task.id))};
  delete draft.files;
  await writeFile(resolve(target,'draft.json'),`${JSON.stringify(draft,null,2)}\n`,
    {encoding:'utf8',flag:'wx'});
  await writeFile(resolve(target,'slice-source.json'),`${JSON.stringify({
    sourceManifestSha256:manifestSha256,sourcePackId:manifest.id,pairIds,
  },null,2)}\n`,{encoding:'utf8',flag:'wx'});
  await freezePack({draftPath:resolve(target,'draft.json'),
    outputPath:resolve(target,'pack.json')});
  const checked=await validatePack(resolve(target,'pack.json'));
  return {path:resolve(target,'pack.json'),...checked};
};
