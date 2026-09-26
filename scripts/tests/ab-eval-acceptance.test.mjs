import assert from 'node:assert/strict';
import test from 'node:test';

const { assessReplicatedAudit } = await import('../ab-eval/acceptance.mjs');

const manifest={pairs:[
  {id:'alpha-1',taskId:'alpha'},{id:'alpha-2',taskId:'alpha'},
  {id:'alpha-3',taskId:'alpha'},{id:'beta-1',taskId:'beta'},
  {id:'beta-2',taskId:'beta'},{id:'beta-3',taskId:'beta'},
]};
const makeAudit=(cTotals=[90,90,115,90,90,115])=>({
  schemaVersion:1,schedulerState:'complete',issues:[],plannedPairs:6,
  completePairs:6,startedArms:12,settledArms:12,
  pairRows:manifest.pairs.map((pair,index)=>({pairId:pair.id,
    complete:true,qualityPass:true,aRawTotal:100,cRawTotal:cTotals[index],
    tokenPass:cTotals[index]<100})),
});

test('one losing repeat per task passes when the pooled token total improves',()=>{
  const result=assessReplicatedAudit({manifest,postflight:makeAudit()});
  assert.equal(result.state,'REPLICATED_GATE_PASS');
  assert.equal(result.passingPairs,4);
  assert.equal(result.aRawTotal,600);
  assert.equal(result.cRawTotal,590);
  assert.deepEqual(result.taskRows.map(row=>[row.taskId,row.passingPairs,
    row.majorityPass]),[['alpha',2,true],['beta',2,true]]);
});

test('one task with only one token win fails despite a lower pooled total',()=>{
  const result=assessReplicatedAudit({manifest,
    postflight:makeAudit([90,90,115,50,105,105])});
  assert.equal(result.state,'REPLICATED_GATE_NOT_PASSED');
  assert.equal(result.cRawTotal,555);
  assert.deepEqual(result.taskRows.map(row=>row.majorityPass),[true,false]);
});

test('a large losing repeat fails the pooled guardrail despite both majorities',()=>{
  const result=assessReplicatedAudit({manifest,
    postflight:makeAudit([90,90,200,90,90,115])});
  assert.equal(result.state,'REPLICATED_GATE_NOT_PASSED');
  assert.equal(result.cRawTotal,675);
  assert.deepEqual(result.taskRows.map(row=>row.majorityPass),[true,true]);
});

test('a tie is not a win',()=>{
  const result=assessReplicatedAudit({manifest,
    postflight:makeAudit([90,100,115,90,90,115])});
  assert.equal(result.state,'REPLICATED_GATE_NOT_PASSED');
  assert.equal(result.taskRows[0].passingPairs,1);
});

test('quality or audit issues cannot be masked by token savings',()=>{
  const quality=makeAudit();
  quality.pairRows[0].qualityPass=false;
  assert.equal(assessReplicatedAudit({manifest,postflight:quality}).state,
    'REPLICATED_GATE_NOT_PASSED');
  const issue=makeAudit();
  issue.issues.push('ARM_AUDIT_FAILED:alpha-1-C');
  assert.equal(assessReplicatedAudit({manifest,postflight:issue}).state,
    'REPLICATED_GATE_NOT_PASSED');
});

test('incomplete or unbalanced batches are ineligible for the replicated policy',()=>{
  const incomplete=makeAudit();
  incomplete.pairRows[0].complete=false;
  incomplete.completePairs=5;
  assert.equal(assessReplicatedAudit({manifest,postflight:incomplete}).state,
    'REPLICATED_GATE_INELIGIBLE');
  const shortManifest={pairs:manifest.pairs.slice(0,4)};
  assert.equal(assessReplicatedAudit({manifest:shortManifest,
    postflight:makeAudit()}).state,'REPLICATED_GATE_INELIGIBLE');
});

test('mismatched pair ids and inconsistent token flags cannot pass',()=>{
  const wrongId=makeAudit();
  wrongId.pairRows[0].pairId='other';
  assert.equal(assessReplicatedAudit({manifest,postflight:wrongId}).state,
    'REPLICATED_GATE_INELIGIBLE');
  const wrongFlag=makeAudit();
  wrongFlag.pairRows[0].tokenPass=false;
  assert.equal(assessReplicatedAudit({manifest,postflight:wrongFlag}).state,
    'REPLICATED_GATE_INELIGIBLE');
});
