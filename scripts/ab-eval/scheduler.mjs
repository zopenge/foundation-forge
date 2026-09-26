import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const fail=code=>Object.assign(new Error(code),{code});
const finite=value=>Number.isFinite(value)&&value>=0;
const writeJson=(path,value)=>writeFile(path,`${JSON.stringify(value,null,2)}\n`,
  {encoding:'utf8',flag:'wx'});

const completeReceipt=(receipt,attempt)=>receipt?.attemptId===attempt.attemptId
  &&receipt.arm===attempt.arm&&receipt.success===true
  &&receipt.accountingStatus==='complete'
  &&receipt.sideEffectStatus==='KNOWN_COMPLETED'
  &&typeof receipt.qualityPass==='boolean'
  &&Number.isSafeInteger(receipt.normalizedUsage?.rawTotal)
  &&receipt.normalizedUsage.rawTotal>=0&&finite(receipt.costUsd)
  &&Array.isArray(receipt.toolNames)
  &&receipt.toolNames.every(name=>typeof name==='string'&&name.length>0);

const validatePlan=({pairs,concurrency,allowedTools,runArm})=>{
  if(!Array.isArray(pairs)||pairs.length===0||!Number.isInteger(concurrency)
    ||concurrency<1||concurrency>pairs.length||typeof runArm!=='function'
    ||!Array.isArray(allowedTools?.A)||!Array.isArray(allowedTools?.C))
    throw fail('PAIR_PLAN_INVALID');
  const ids=new Set();
  for(const pair of pairs){
    if(typeof pair.id!=='string'||!/^[a-z0-9][a-z0-9-]*$/u.test(pair.id)
      ||ids.has(pair.id)||!['AC','CA'].includes(pair.order))
      throw fail('PAIR_PLAN_INVALID');
    ids.add(pair.id);
  }
};

export const runPairSchedule=async({pairs,concurrency,journalDir,allowedTools,runArm,
  gateMode='stop',continueOnRunFailure=false,writeJournal=writeJson})=>{
  validatePlan({pairs,concurrency,allowedTools,runArm});
  if(!['stop','collect'].includes(gateMode))throw fail('PAIR_GATE_MODE_INVALID');
  if(typeof continueOnRunFailure!=='boolean'
    ||(continueOnRunFailure&&gateMode!=='collect'))
    throw fail('PAIR_RUN_FAILURE_MODE_INVALID');
  await mkdir(journalDir,{recursive:true});
  if((await readdir(journalDir)).length>0)throw fail('JOURNAL_NOT_EMPTY');
  let nextPair=0;let state='complete';let reason=null;
  const receipts=[];
  const gateFailures=[];
  const armErrors=[];
  const stop=(nextState,nextReason)=>{
    if(reason===null||(nextState==='blocked'&&state!=='blocked')){
      state=nextState;reason=nextReason;
    }
  };
  const worker=async()=>{
    while(reason===null&&nextPair<pairs.length){
      const pair=pairs[nextPair++];
      const pairReceipts=[];
      for(const arm of pair.order){
        if(state==='blocked')break;
        const attempt={attemptId:`${pair.id}-${arm}`,pairId:pair.id,
          taskId:pair.taskId,arm};
        try{
          await writeJournal(resolve(journalDir,`${attempt.attemptId}.started.json`),
            {attemptId:attempt.attemptId,startedAtUtc:new Date().toISOString()});
        }catch{stop('blocked','JOURNAL_WRITE_FAILED');break;}
        let receipt;
        try{receipt=await runArm(attempt);}catch(error){
          if(continueOnRunFailure&&error?.code==='OPENCODE_RUN_FAILED'){
            try{
              await writeJournal(resolve(journalDir,`${attempt.attemptId}.failed.json`),
                {attemptId:attempt.attemptId,code:'ARM_RUN_FAILED'});
            }catch{stop('blocked','JOURNAL_WRITE_FAILED');break;}
            armErrors.push({code:'ARM_RUN_FAILED',pairId:pair.id,
              attemptId:attempt.attemptId});
            break;
          }
          stop('blocked','UNKNOWN_SIDE_EFFECT');break;
        }
        if(receipt?.attemptId!==attempt.attemptId){
          stop('blocked','UNKNOWN_SIDE_EFFECT');break;
        }
        try{
          await writeJournal(resolve(journalDir,`${attempt.attemptId}.settled.json`),receipt);
        }catch{stop('blocked','JOURNAL_WRITE_FAILED');break;}
        receipts.push(receipt);pairReceipts.push(receipt);
        if(!completeReceipt(receipt,attempt)){
          stop('blocked','ARM_GATE_FAILED');break;
        }
        const invalidTools=receipt.toolNames.filter(name=>!allowedTools[attempt.arm].includes(name));
        if(invalidTools.length>0){
          gateFailures.push({code:'ARM_TOOL_BOUNDARY_FAILED',pairId:pair.id,
            attemptId:attempt.attemptId,tools:invalidTools});
          if(gateMode==='stop'){stop('blocked','ARM_GATE_FAILED');break;}
        }
        if(receipt.qualityPass!==true){
          gateFailures.push({code:'ARM_QUALITY_FAILED',pairId:pair.id,
            attemptId:attempt.attemptId});
          if(gateMode==='stop'){stop('blocked','ARM_GATE_FAILED');break;}
        }
      }
      if(pairReceipts.length===2&&state!=='blocked'){
        const a=pairReceipts.find(x=>x.arm==='A');
        const c=pairReceipts.find(x=>x.arm==='C');
        if(c.normalizedUsage.rawTotal>=a.normalizedUsage.rawTotal){
          gateFailures.push({code:'PAIR_TOKEN_REGRESSION',pairId:pair.id});
          if(gateMode==='stop')stop('stopped','PAIR_TOKEN_REGRESSION');
        }
      }
    }
  };
  await Promise.all(Array.from({length:concurrency},()=>worker()));
  if(armErrors.length>0&&state==='complete')stop('blocked','UNKNOWN_SIDE_EFFECT');
  const pairOrder=new Map(pairs.map((pair,index)=>[pair.id,index]));
  gateFailures.sort((a,b)=>pairOrder.get(a.pairId)-pairOrder.get(b.pairId)
    ||a.code.localeCompare(b.code));
  armErrors.sort((a,b)=>pairOrder.get(a.pairId)-pairOrder.get(b.pairId));
  return {state,reason,gateMode,gateFailures,armErrors,plannedPairs:pairs.length,
    startedArms:receipts.length+(await readdir(journalDir))
      .filter(name=>name.endsWith('.started.json')
        &&!receipts.some(x=>`${x.attemptId}.started.json`===name)).length,
    settledArms:receipts.length,receipts};
};
