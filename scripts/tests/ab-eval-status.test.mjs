import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { inspectEvaluationStatus } from '../ab-eval/status.mjs';

const tempRoot=resolve(import.meta.dirname,'../../.tmp');
const writeJson=(path,value)=>writeFile(path,`${JSON.stringify(value)}\n`);
test('status summarizes in-flight arms and known A/B issues without writing files',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-status-'));
  try{
    const manifestPath=resolve(root,'pack.json');
    const manifest={pairs:[{id:'pair-1',taskId:'task',order:'AC'},
      {id:'pair-2',taskId:'task',order:'AC'}],
      allowedTools:{A:['read'],C:['repository_context_investigate']}};
    const manifestBytes=`${JSON.stringify(manifest)}\n`;
    await writeFile(manifestPath,manifestBytes);
    const arms=manifest.pairs.flatMap(pair=>['A','C'].map(arm=>({
      attemptId:`${pair.id}-${arm}`,pairId:pair.id,arm})));
    await writeJson(resolve(root,'preflight.json'),{runId:'status-test',
      manifestPath,manifestSha256:createHash('sha256')
        .update(manifestBytes).digest('hex').toUpperCase(),arms});
    await mkdir(resolve(root,'journal'));
    const started=async id=>writeJson(resolve(root,'journal',`${id}.started.json`),
      {attemptId:id});
    const settled=async(id,arm,rawTotal,toolNames)=>writeJson(
      resolve(root,'journal',`${id}.settled.json`),{attemptId:id,arm,
        success:true,qualityPass:true,accountingStatus:'complete',
        sideEffectStatus:'KNOWN_COMPLETED',normalizedUsage:{rawTotal},
        modelInvocationCount:1,costUsd:0,toolNames});
    await started('pair-1-A');await settled('pair-1-A','A',100,['read']);
    await started('pair-1-C');await settled('pair-1-C','C',120,
      ['repository_context_continue']);
    await started('pair-2-A');
    await writeJson(resolve(root,'run.lock.json'),{runId:'status-test',
      gateMode:'collect'});
    const before=await readFile(resolve(root,'preflight.json'),'utf8');
    const status=await inspectEvaluationStatus({runDir:root});
    assert.equal(status.state,'running');
    assert.equal(status.gateMode,'collect');
    assert.equal(status.startedArms,3);
    assert.equal(status.settledArms,2);
    assert.deepEqual(status.inFlightArmIds,['pair-2-A']);
    assert.deepEqual(status.failedArmIds,[]);
    assert.equal(status.completePairs,1);
    assert.deepEqual(status.tokenRegressions,['pair-1']);
    assert.deepEqual(status.toolBoundaryFailures,[{attemptId:'pair-1-C',
      tools:['repository_context_continue']}]);
    assert.equal(status.modelCalls,2);
    assert.equal(await readFile(resolve(root,'preflight.json'),'utf8'),before);
    await writeJson(resolve(root,'journal/pair-2-A.failed.json'),
      {attemptId:'pair-2-A',code:'ARM_RUN_FAILED'});
    const afterFailure=await inspectEvaluationStatus({runDir:root});
    assert.deepEqual(afterFailure.inFlightArmIds,[]);
    assert.deepEqual(afterFailure.failedArmIds,['pair-2-A']);
    assert.deepEqual(afterFailure.unsettledArmIds,['pair-2-A']);
    await writeJson(resolve(root,'result.json'),{runId:'status-test',
      state:'blocked',reason:'ARM_GATE_FAILED'});
    const finished=await inspectEvaluationStatus({runDir:root});
    assert.equal(finished.state,'blocked');
    assert.equal(finished.reason,'ARM_GATE_FAILED');
    assert.deepEqual(finished.inFlightArmIds,[]);
    assert.deepEqual(finished.unsettledArmIds,['pair-2-A']);
    const cli=spawnSync(process.execPath,[resolve(import.meta.dirname,'../ab-eval.mjs'),
      'status','--run-dir',root],{encoding:'utf8'});
    assert.equal(cli.status,0);
    assert.equal(JSON.parse(cli.stdout).state,'blocked');
  }finally{await rm(root,{recursive:true,force:true});}
});
