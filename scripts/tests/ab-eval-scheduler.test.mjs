import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers';

import { runPairSchedule } from '../ab-eval/scheduler.mjs';

const repoRoot=resolve(import.meta.dirname,'../..');
const tempRoot=resolve(repoRoot,'.tmp');
const withJournal=async fn=>{
  await mkdir(tempRoot,{recursive:true});
  const dir=await mkdtemp(resolve(tempRoot,'ab-eval-schedule-'));
  if(!dir.startsWith(tempRoot+sep))throw new Error('TEST_TEMP_OUTSIDE_WORKSPACE');
  try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}
};
const pairs=Array.from({length:5},(_,i)=>({id:`pair-${i+1}`,taskId:'task',
  order:i===3?'CA':'AC'}));
const receipt=(attempt,rawTotal)=>({attemptId:attempt.attemptId,arm:attempt.arm,
  success:true,qualityPass:true,accountingStatus:'complete',
  sideEffectStatus:'KNOWN_COMPLETED',normalizedUsage:{rawTotal},
  costUsd:0.01,toolNames:attempt.arm==='A'?['read']:['repository_context_investigate']});
const allowedTools={A:['read'],C:['repository_context_investigate']};

test('first regressed pair stops new pairs and drains already claimed pairs',()=>withJournal(async dir=>{
  const started=[];
  const result=await runPairSchedule({pairs,concurrency:3,journalDir:dir,allowedTools,
    runArm:async attempt=>{
      started.push(attempt.attemptId);
      if(attempt.pairId==='pair-2'||attempt.pairId==='pair-3')
        await new Promise(done=>setTimeout(done,20));
      return receipt(attempt,attempt.arm==='A'?100:
        attempt.pairId==='pair-1'?110:90);
    }});
  assert.equal(result.state,'stopped');
  assert.equal(result.reason,'PAIR_TOKEN_REGRESSION');
  assert.equal(result.receipts.length,6);
  assert.ok(started.every(id=>!id.startsWith('pair-4')&&!id.startsWith('pair-5')));
  assert.equal((await readdir(dir)).filter(name=>name.endsWith('.settled.json')).length,6);
}));

test('collect mode settles every pair despite known quality and token failures',()=>withJournal(async dir=>{
  const started=[];
  const result=await runPairSchedule({pairs,concurrency:3,journalDir:dir,allowedTools,
    gateMode:'collect',runArm:async attempt=>{
      started.push(attempt.attemptId);
      const value=receipt(attempt,attempt.arm==='A'?100:
        attempt.pairId==='pair-1'?110:90);
      if(attempt.attemptId==='pair-2-C')value.qualityPass=false;
      return value;
    }});
  assert.equal(result.state,'complete');
  assert.equal(result.reason,null);
  assert.equal(result.settledArms,10);
  assert.equal(started.length,10);
  assert.deepEqual(result.gateFailures,[
    {code:'PAIR_TOKEN_REGRESSION',pairId:'pair-1'},
    {code:'ARM_QUALITY_FAILED',pairId:'pair-2',attemptId:'pair-2-C'},
  ]);
  assert.equal((await readdir(dir)).filter(name=>name.endsWith('.settled.json')).length,10);
}));

test('collect mode records a known tool boundary failure and settles remaining pairs',()=>withJournal(async dir=>{
  const started=[];
  const result=await runPairSchedule({pairs,concurrency:3,journalDir:dir,allowedTools,
    gateMode:'collect',runArm:async attempt=>{
      started.push(attempt.attemptId);
      const value=receipt(attempt,attempt.arm==='A'?100:
        attempt.pairId==='pair-1'?110:90);
      if(attempt.attemptId==='pair-1-C')
        value.toolNames.push('repository_context_continue');
      return value;
    }});
  assert.equal(result.state,'complete');
  assert.equal(result.reason,null);
  assert.equal(result.startedArms,10);
  assert.equal(result.settledArms,10);
  assert.equal(started.length,10);
  assert.deepEqual(result.gateFailures,[
    {code:'ARM_TOOL_BOUNDARY_FAILED',pairId:'pair-1',attemptId:'pair-1-C',
      tools:['repository_context_continue']},
    {code:'PAIR_TOKEN_REGRESSION',pairId:'pair-1'},
  ]);
  assert.equal((await readdir(dir)).filter(name=>name.endsWith('.settled.json')).length,10);
}));

test('stop mode records a known tool boundary failure before blocking',()=>withJournal(async dir=>{
  const result=await runPairSchedule({pairs,concurrency:1,journalDir:dir,allowedTools,
    runArm:async attempt=>{
      const value=receipt(attempt,90);
      if(attempt.arm==='C')value.toolNames.push('repository_context_continue');
      return value;
    }});
  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'ARM_GATE_FAILED');
  assert.equal(result.settledArms,2);
  assert.deepEqual(result.gateFailures,[
    {code:'ARM_TOOL_BOUNDARY_FAILED',pairId:'pair-1',attemptId:'pair-1-C',
      tools:['repository_context_continue']},
  ]);
}));

test('collect mode still blocks when accounting is unknown',()=>withJournal(async dir=>{
  const result=await runPairSchedule({pairs,concurrency:1,journalDir:dir,allowedTools,
    gateMode:'collect',runArm:async attempt=>{
      const value=receipt(attempt,90);
      value.accountingStatus='incomplete';
      return value;
    }});
  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'ARM_GATE_FAILED');
  assert.equal(result.settledArms,1);
}));

test('collect mode blocks when quality outcome is missing',()=>withJournal(async dir=>{
  const result=await runPairSchedule({pairs,concurrency:1,journalDir:dir,allowedTools,
    gateMode:'collect',runArm:async attempt=>{
      const value=receipt(attempt,90);
      delete value.qualityPass;
      return value;
    }});
  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'ARM_GATE_FAILED');
  assert.equal(result.settledArms,1);
  assert.deepEqual(result.gateFailures,[]);
}));

test('unknown arm effects leave a started journal and prevent replay',()=>withJournal(async dir=>{
  const run=()=>runPairSchedule({pairs:pairs.slice(0,1),concurrency:1,
    journalDir:dir,allowedTools,runArm:async()=>{throw new Error('process lost');}});
  const first=await run();
  assert.equal(first.state,'blocked');
  assert.equal(first.reason,'UNKNOWN_SIDE_EFFECT');
  assert.equal((await readdir(dir)).filter(name=>name.endsWith('.started.json')).length,1);
  await assert.rejects(run,{code:'JOURNAL_NOT_EMPTY'});
}));

test('collect mode can keep independent pairs after an OpenCode run failure without replaying the failed arm',()=>withJournal(async dir=>{
  const seen=[];
  const result=await runPairSchedule({pairs,concurrency:1,journalDir:dir,
    allowedTools,gateMode:'collect',continueOnRunFailure:true,
    runArm:async attempt=>{
      seen.push(attempt.attemptId);
      if(['pair-1-A','pair-3-C'].includes(attempt.attemptId))
        throw Object.assign(new Error('model run failed'),{code:'OPENCODE_RUN_FAILED'});
      return receipt(attempt,attempt.arm==='A'?100:90);
    }});
  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'UNKNOWN_SIDE_EFFECT');
  assert.equal(result.startedArms,9);
  assert.equal(result.settledArms,7);
  assert.deepEqual(result.armErrors,[
    {code:'ARM_RUN_FAILED',pairId:'pair-1',attemptId:'pair-1-A'},
    {code:'ARM_RUN_FAILED',pairId:'pair-3',attemptId:'pair-3-C'},
  ]);
  assert.deepEqual(seen,['pair-1-A','pair-2-A','pair-2-C','pair-3-A',
    'pair-3-C','pair-4-C','pair-4-A','pair-5-A','pair-5-C']);
  assert.equal((await readdir(dir)).filter(name=>name.endsWith('.settled.json')).length,7);
  assert.equal((await readdir(dir)).filter(name=>name.endsWith('.started.json')).length,9);
  assert.deepEqual(JSON.parse(await readFile(resolve(dir,'pair-1-A.failed.json'),'utf8')),
    {attemptId:'pair-1-A',code:'ARM_RUN_FAILED'});
  assert.deepEqual(JSON.parse(await readFile(resolve(dir,'pair-3-C.failed.json'),'utf8')),
    {attemptId:'pair-3-C',code:'ARM_RUN_FAILED'});
}));

test('collect run-failure option still stops on source drift',()=>withJournal(async dir=>{
  const seen=[];
  const result=await runPairSchedule({pairs,concurrency:1,journalDir:dir,
    allowedTools,gateMode:'collect',continueOnRunFailure:true,
    runArm:async attempt=>{
      seen.push(attempt.attemptId);
      throw Object.assign(new Error('fixture changed'),{code:'ARM_SOURCE_DRIFT'});
    }});
  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'UNKNOWN_SIDE_EFFECT');
  assert.deepEqual(seen,['pair-1-A']);
  assert.equal(result.startedArms,1);
  assert.equal(result.settledArms,0);
}));

test('CA order runs C before A and records both settled receipts',()=>withJournal(async dir=>{
  const seen=[];
  const result=await runPairSchedule({pairs:[pairs[3]],concurrency:1,
    journalDir:dir,allowedTools,runArm:async attempt=>{
      seen.push(attempt.arm);return receipt(attempt,attempt.arm==='A'?100:90);
    }});
  assert.equal(result.state,'complete');
  assert.deepEqual(seen,['C','A']);
  assert.equal(JSON.parse(await readFile(resolve(dir,'pair-4-C.settled.json'),'utf8')).arm,'C');
}));

test('settlement journal failure blocks later calls and preserves unknown start',()=>withJournal(async dir=>{
  const seen=[];
  const result=await runPairSchedule({pairs:pairs.slice(0,1),concurrency:1,
    journalDir:dir,allowedTools,runArm:async attempt=>{
      seen.push(attempt.arm);return receipt(attempt,100);
    },writeJournal:async(path,value)=>{
      if(path.endsWith('.settled.json'))throw new Error('disk unavailable');
      await writeFile(path,JSON.stringify(value),{flag:'wx'});
    }});
  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'JOURNAL_WRITE_FAILED');
  assert.deepEqual(seen,['A']);
  assert.equal(result.settledArms,0);
  assert.equal(result.startedArms,1);
}));
