import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { freezePack, validatePack } from '../../../scripts/ab-eval/manifest.mjs';

const temporaryRoot=resolve(import.meta.dirname,'../../../.tmp');
const fail=code=>Object.assign(new Error(code),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const inside=(base,path)=>path===base||path.startsWith(base+sep);
const safeEntry=name=>name.startsWith('package/')&&!name.includes('\\')
  &&!name.includes(':')&&name.split('/').every((part,index)=>part.length>0
    &&part!=='.'&&part!=='..'&&!(index===1&&part===''));
const comparable=value=>JSON.stringify(Object.entries(value??{})
  .sort(([left],[right])=>left.localeCompare(right)));

const readPackageEntries=bytes=>{
  let tar;
  try{tar=gunzipSync(bytes,{maxOutputLength:128*1024*1024});}
  catch{throw fail('H8_CANDIDATE_TARBALL_INVALID');}
  const entries=new Map();
  let cursor=0;
  while(cursor+512<=tar.length){
    const header=tar.subarray(cursor,cursor+512);
    if(header.every(byte=>byte===0))break;
    const name=header.toString('utf8',0,100).replace(/\0.*$/u,'');
    const prefix=header.toString('utf8',345,500).replace(/\0.*$/u,'');
    const size=Number.parseInt(header.toString('ascii',124,136)
      .replace(/\0.*$/u,'').trim(),8);
    const type=header[156];
    if(header.toString('ascii',257,262)!=='ustar'||prefix!==''
      ||!safeEntry(name)||!Number.isSafeInteger(size)||size<0
      ||cursor+512+size>tar.length||![0,48].includes(type)
      ||entries.has(name))throw fail('H8_CANDIDATE_TARBALL_INVALID');
    entries.set(name,tar.subarray(cursor+512,cursor+512+size));
    cursor+=512+Math.ceil(size/512)*512;
  }
  if(!entries.has('package/package.json')||!entries.has('package/dist/node/cli.js'))
    throw fail('H8_CANDIDATE_TARBALL_INVALID');
  return entries;
};

export const rebaseH8Candidate=async({manifestPath,candidatePath,outputDir,id})=>{
  const {manifest,base,manifestSha256}=await validatePack(manifestPath);
  const target=resolve(outputDir);
  const archive=resolve(candidatePath);
  if(!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(id)
    ||!inside(temporaryRoot,target)||target===temporaryRoot
    ||!inside(temporaryRoot,archive)||!inside(temporaryRoot,base)
    ||inside(base,target)||inside(target,base)||inside(target,archive))
    throw fail('H8_REBASE_ARGUMENT_INVALID');
  const candidateBytes=await readFile(archive);
  const entries=readPackageEntries(candidateBytes);
  const packed=JSON.parse(entries.get('package/package.json').toString('utf8'));
  const previous=JSON.parse(await readFile(resolve(base,
    'runtime/consumer/package/package.json'),'utf8'));
  if(packed.name!==previous.name
    ||comparable(packed.dependencies)!==comparable(previous.dependencies)
    ||comparable(packed.bin)!==comparable(previous.bin))
    throw fail('H8_CANDIDATE_CONTRACT_DRIFT');
  await mkdir(dirname(target),{recursive:true});
  await mkdir(target,{recursive:false});
  const skipped=new Set([manifest.candidate,'draft.json','candidate-rebase.json',
    'runtime/consumer/package/package.json']);
  const sourcePaths=Object.keys(manifest.files).filter(path=>!skipped.has(path)
    &&!path.startsWith('runtime/consumer/package/dist/'));
  for(let start=0;start<sourcePaths.length;start+=32){
    await Promise.all(sourcePaths.slice(start,start+32).map(async path=>{
      const destination=resolve(target,...path.split('/'));
      await mkdir(dirname(destination),{recursive:true});
      await cp(resolve(base,...path.split('/')),destination,
        {force:false,errorOnExist:true});
    }));
  }
  await writeFile(resolve(target,manifest.candidate),candidateBytes,{flag:'wx'});
  for(const [name,content] of entries){
    if(name!=='package/package.json'&&!name.startsWith('package/dist/'))continue;
    const destination=resolve(target,'runtime/consumer',...name.split('/'));
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,content,{flag:'wx'});
  }
  await writeFile(resolve(target,'candidate-rebase.json'),`${JSON.stringify({
    sourceManifestSha256:manifestSha256,
    previousCandidateSha256:manifest.files[manifest.candidate],
    candidateSha256:sha(candidateBytes),packageName:packed.name,
    packageVersion:packed.version,
  },null,2)}\n`,{encoding:'utf8',flag:'wx'});
  const draft={...manifest,id};
  delete draft.files;
  await writeFile(resolve(target,'draft.json'),`${JSON.stringify(draft,null,2)}\n`,
    {encoding:'utf8',flag:'wx'});
  await freezePack({draftPath:resolve(target,'draft.json'),
    outputPath:resolve(target,'pack.json')});
  const checked=await validatePack(resolve(target,'pack.json'));
  return {state:'H8_CANDIDATE_REBASED',path:resolve(target,'pack.json'),
    manifestSha256:checked.manifestSha256,candidateSha256:sha(candidateBytes),
    tasks:checked.manifest.tasks.length,pairs:checked.manifest.pairs.length};
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [sourceFlag,manifestPath,candidateFlag,candidatePath,
    outputFlag,outputDir,idFlag,id]=process.argv.slice(2);
  if(sourceFlag!=='--source-pack'||candidateFlag!=='--candidate'
    ||outputFlag!=='--out'||idFlag!=='--id'
    ||!manifestPath||!candidatePath||!outputDir||!id)
    throw fail('H8_REBASE_ARGUMENT_INVALID');
  process.stdout.write(`${JSON.stringify(await rebaseH8Candidate({
    manifestPath,candidatePath,outputDir,id}))}\n`);
}
