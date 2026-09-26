import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const fail=code=>Object.assign(new Error(code),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const optionalJson=async path=>{
  try{return await readJson(path);}
  catch(error){if(error?.code==='ENOENT')return null;throw error;}
};
const optionalNames=async path=>{
  try{return await readdir(path);}
  catch(error){if(error?.code==='ENOENT')return [];throw error;}
};

export const inspectEvaluationStatus=async({runDir})=>{
  const root=resolve(runDir);
  const preflight=await readJson(resolve(root,'preflight.json'));
  if(typeof preflight.runId!=='string'||!Array.isArray(preflight.arms)
    ||typeof preflight.manifestPath!=='string')throw fail('STATUS_PREFLIGHT_INVALID');
  const manifestBytes=await readFile(preflight.manifestPath);
  if(preflight.manifestSha256&&sha(manifestBytes)!==preflight.manifestSha256)
    throw fail('STATUS_MANIFEST_DRIFT');
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(!Array.isArray(manifest.pairs)||!Array.isArray(manifest.allowedTools?.A)
    ||!Array.isArray(manifest.allowedTools?.C))throw fail('STATUS_MANIFEST_INVALID');
  const [names,lock,result]=await Promise.all([
    optionalNames(resolve(root,'journal')),
    optionalJson(resolve(root,'run.lock.json')),
    optionalJson(resolve(root,'result.json')),
  ]);
  if((lock&&lock.runId!==preflight.runId)
    ||(result&&result.runId!==preflight.runId))throw fail('STATUS_RUN_ID_DRIFT');
  const files=new Set(names);
  const arms=[];
  for(const arm of preflight.arms){
    const started=files.has(`${arm.attemptId}.started.json`);
    const settled=files.has(`${arm.attemptId}.settled.json`);
    const failed=files.has(`${arm.attemptId}.failed.json`);
    const receipt=settled?await readJson(resolve(root,'journal',
      `${arm.attemptId}.settled.json`)):null;
    const invalidTools=Array.isArray(receipt?.toolNames)
      ?receipt.toolNames.filter(name=>!manifest.allowedTools[arm.arm].includes(name)):[];
    arms.push({attemptId:arm.attemptId,pairId:arm.pairId,arm:arm.arm,
      started,settled,failed,rawTotal:receipt?.normalizedUsage?.rawTotal??null,
      modelCalls:receipt?.modelInvocationCount??null,
      qualityPass:receipt?.qualityPass??null,
      accountingStatus:receipt?.accountingStatus??null,
      sideEffectStatus:receipt?.sideEffectStatus??null,invalidTools});
  }
  const pairs=manifest.pairs.map(pair=>{
    const a=arms.find(arm=>arm.pairId===pair.id&&arm.arm==='A');
    const c=arms.find(arm=>arm.pairId===pair.id&&arm.arm==='C');
    const complete=a?.settled===true&&c?.settled===true;
    return {pairId:pair.id,complete,
      aRawTotal:a?.rawTotal??null,cRawTotal:c?.rawTotal??null,
      aModelCalls:a?.modelCalls??null,cModelCalls:c?.modelCalls??null,
      tokenPass:complete&&Number.isSafeInteger(a.rawTotal)
        &&Number.isSafeInteger(c.rawTotal)?c.rawTotal<a.rawTotal:null};
  });
  const unsettledArmIds=arms.filter(arm=>arm.started&&!arm.settled)
    .map(arm=>arm.attemptId);
  const failedArmIds=arms.filter(arm=>arm.failed).map(arm=>arm.attemptId);
  return {schemaVersion:1,runId:preflight.runId,
    state:result?.state??(lock?'running':'prepared'),
    reason:result?.reason??null,gateMode:lock?.gateMode??null,
    plannedPairs:manifest.pairs.length,plannedArms:preflight.arms.length,
    startedArms:arms.filter(arm=>arm.started).length,
    settledArms:arms.filter(arm=>arm.settled).length,
    inFlightArmIds:lock&&!result?arms.filter(arm=>arm.started
      &&!arm.settled&&!arm.failed).map(arm=>arm.attemptId):[],
    unsettledArmIds,failedArmIds,
    completePairs:pairs.filter(pair=>pair.complete).length,
    modelCalls:arms.reduce((sum,arm)=>sum+(arm.modelCalls??0),0),
    tokenRegressions:pairs.filter(pair=>pair.complete&&pair.tokenPass===false)
      .map(pair=>pair.pairId),
    qualityFailedArmIds:arms.filter(arm=>arm.settled&&arm.qualityPass!==true)
      .map(arm=>arm.attemptId),
    accountingUnknownArmIds:arms.filter(arm=>arm.settled
      &&arm.accountingStatus!=='complete').map(arm=>arm.attemptId),
    toolBoundaryFailures:arms.filter(arm=>arm.invalidTools.length>0)
      .map(arm=>({attemptId:arm.attemptId,tools:arm.invalidTools})),
    pairs:pairs.filter(pair=>arms.some(arm=>arm.pairId===pair.pairId
      &&arm.started)),
  };
};
