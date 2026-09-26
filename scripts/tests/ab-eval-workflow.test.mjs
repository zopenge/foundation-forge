import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';

import { freezePack } from '../ab-eval/manifest.mjs';
import { diagnoseEvaluation } from '../ab-eval/diagnostics.mjs';
import { makeTarballFixture } from './ab-eval-tarball-fixture.mjs';
import { auditEvaluation, executeEvaluation, prepareEvaluation,
  verifyEvaluationConnections } from '../ab-eval/workflow.mjs';

const repoRoot=resolve(import.meta.dirname,'../..');
const tempRoot=resolve(repoRoot,'.tmp');
const withFixture=async fn=>{
  await mkdir(tempRoot,{recursive:true});
  const dir=await mkdtemp(resolve(tempRoot,'ab-eval-workflow-'));
  if(!dir.startsWith(tempRoot+sep))throw new Error('TEST_TEMP_OUTSIDE_WORKSPACE');
  try{
    const pack=resolve(dir,'pack');
    await mkdir(resolve(pack,'fixture'),{recursive:true});
    await writeFile(resolve(pack,'fixture/source.txt'),'before\n');
    await writeFile(resolve(pack,'candidate.tgz'),makeTarballFixture());
    await writeFile(resolve(pack,'a.json'),JSON.stringify({work:'{{WORK_DIR}}',
      permission:{'*':'deny',read:'allow'}}));
    await writeFile(resolve(pack,'c.json'),JSON.stringify({
      permission:{'*':'deny',repository_context_investigate:'allow'},
      mcp:{repository_context:{type:'local',enabled:true,timeout:30000,
        command:['{{NODE}}','{{PACK_DIR}}/context.mjs','{{CANDIDATE}}']}}}));
    await writeFile(resolve(pack,'context.mjs'),'// model-disabled fixture\n');
    await writeFile(resolve(pack,'public.mjs'),'process.exit(0);\n');
    await writeFile(resolve(pack,'hidden.mjs'),'process.exit(0);\n');
    await writeFile(resolve(pack,'setup.mjs'),'process.exit(0);\n');
    const draft={schemaVersion:1,id:'workflow-smoke',candidate:'candidate.tgz',
      client:{kind:'opencode',version:'1.18.30',model:'vendor/model',variant:'high',agent:'build'},
      configs:{A:'a.json',C:'c.json'},
      tasks:[{id:'task',fixture:'fixture',prompt:'Fix this task.',
        setup:'setup.mjs',publicVerifier:'public.mjs',hiddenVerifier:'hidden.mjs'}],
      pairs:[{id:'pair-1',taskId:'task',order:'AC'}],concurrency:1,
      armTimeoutMs:600000,allowedTools:{A:['read'],C:['repository_context_investigate']},
      toolContract:{A:{native:['read'],mcp:{}},C:{native:[],mcp:{repository_context:{
        investigate:createHash('sha256').update('{"properties":{},"type":"object"}')
          .digest('hex').toUpperCase()}}}}};
    await writeFile(resolve(pack,'draft.json'),JSON.stringify(draft));
    await freezePack({draftPath:resolve(pack,'draft.json'),outputPath:resolve(pack,'pack.json')});
    const client=resolve(dir,'opencode.exe');
    const auth=resolve(dir,'auth.json');
    await writeFile(client,'fake-client-binary');
    await writeFile(auth,'{"token":"test-only"}');
    await fn({pack,runDir:resolve(dir,'run'),client,auth});
  }finally{await rm(dir,{recursive:true,force:true});}
};

test('portable workflow prepares, requires approval, runs and audits one A/C pair',()=>withFixture(async paths=>{
  const calls=[];
  const processRunner=async spec=>{
    calls.push(spec.args[0]);
    if(spec.args[0]==='--version')return {status:0,stdout:'1.18.30\n',stderr:''};
    if(spec.args[0]==='mcp')return {status:0,
      stdout:'repository_context connected\n',stderr:''};
    if(spec.args[0].endsWith('setup.mjs')){
      assert.equal(spec.args[4],spec.args[2].endsWith('pair-1-C')?'C':'A');
      assert.equal(spec.args[5],'task');
      await writeFile(resolve(spec.args[1],'setup-ran.txt'),'prepared\n');
      return {status:0,stdout:'',stderr:''};
    }
    if(spec.args[0]==='run'){
      const arm=spec.env.OPENCODE_CONFIG.includes('pair-1-C')?'C':'A';
      const tokens={input:arm==='A'?80:60,output:10,reasoning:10,
        cache:{read:0,write:0}};
      return {status:0,stdout:JSON.stringify({sessionID:`ses_${arm}`,type:'step_finish',
        part:{type:'step-finish',cost:0.01,tokens}})+'\n',stderr:''};
    }
    if(spec.args[0]==='export'){
      const arm=spec.args.at(-1).slice(-1);
      const tokens={input:arm==='A'?80:60,output:10,reasoning:10,
        cache:{read:0,write:0}};
      return {status:0,stdout:JSON.stringify({info:{id:`ses_${arm}`,version:'1.18.30',
        model:{providerID:'vendor',id:'model',variant:'high'}},messages:[{info:{
          role:'assistant',providerID:'vendor',modelID:'model',variant:'high',
          cost:0.01,tokens},parts:[{type:'tool',tool:arm==='A'?'read':
            'repository_context_investigate',state:{status:'completed'}}]}]}),stderr:''};
    }
    if(spec.args[0].endsWith('public.mjs')||spec.args[0].endsWith('hidden.mjs'))
      assert.equal(spec.args[2],'task');
    return {status:0,stdout:'',stderr:''};
  };
  const preflight=await prepareEvaluation({manifestPath:resolve(paths.pack,'pack.json'),
    runDir:paths.runDir,clientExecutable:paths.client,authPath:paths.auth,processRunner});
  assert.equal(preflight.modelCalls,0);
  assert.equal(preflight.arms.length,2);
  assert.equal((await readFile(resolve(paths.runDir,
    'arms/pair-1-C/work/setup-ran.txt'),'utf8')),'prepared\n');
  const connection=await verifyEvaluationConnections({runDir:paths.runDir,
    processRunner,toolProbe:async()=>({tools:[{name:'investigate',
      inputSchema:{type:'object',properties:{}}}]})});
  assert.equal(connection.modelCalls,0);
  assert.equal(connection.cConnected,1);
  assert.equal(JSON.parse(await readFile(resolve(paths.runDir,'arms/pair-1-C/opencode.json'),'utf8'))
    .mcp.repository_context.command[2],resolve(paths.pack,'candidate.tgz'));
  await assert.rejects(()=>executeEvaluation({runDir:paths.runDir,
    processRunner}),{code:'APPROVAL_REQUIRED'});
  assert.deepEqual(calls,['--version',resolve(paths.pack,'setup.mjs'),
    resolve(paths.pack,'setup.mjs'),'mcp']);
  await writeFile(resolve(paths.runDir,'approval.json'),JSON.stringify({approved:true,
    runId:preflight.runId,manifestSha256:preflight.manifestSha256,
    approvedArmIds:['pair-1-A','pair-1-C'],userAuthorization:'test-only'}));
  await assert.rejects(()=>executeEvaluation({runDir:paths.runDir,
    processRunner,transportObservation:true}),
  {code:'TRANSPORT_UPSTREAM_MISSING'});
  await assert.rejects(()=>executeEvaluation({runDir:paths.runDir,
    processRunner,continueOnRunFailure:true}),
  {code:'PAIR_RUN_FAILURE_MODE_INVALID'});
  await assert.rejects(()=>readFile(resolve(paths.runDir,'run.lock.json')),
    {code:'ENOENT'});
  const result=await executeEvaluation({runDir:paths.runDir,processRunner,
    gateMode:'collect',continueOnRunFailure:true});
  assert.equal(result.state,'complete');
  assert.equal(result.continueOnRunFailure,true);
  assert.equal(JSON.parse(await readFile(resolve(paths.runDir,'run.lock.json'),'utf8'))
    .continueOnRunFailure,true);
  await assert.rejects(()=>executeEvaluation({runDir:paths.runDir,
    processRunner}),{code:'RUN_ALREADY_STARTED'});
  assert.equal(calls.filter(call=>call==='run').length,2);
  const report=await auditEvaluation({runDir:paths.runDir});
  assert.equal(report.state,'PAIR_GATE_PASS');
  assert.equal(report.passingPairs,1);
  assert.equal(report.modelCalls,2);
  const originalAudit=await readFile(resolve(paths.runDir,'postflight.json'));
  const { main }=await import('../ab-eval.mjs');
  await assert.rejects(()=>main(['run','--run-dir',paths.runDir,
    '--continue-on-run-failure','on']),
  {code:'PAIR_RUN_FAILURE_MODE_INVALID'});
  await assert.rejects(()=>main(['run','--run-dir',paths.runDir,
    '--gate-mode','collect','--continue-on-run-failure','off']),
  {code:'AB_EVAL_ARGUMENT_INVALID'});
  const assessment=await main(['assess','--run-dir',paths.runDir]);
  assert.equal(assessment.state,'REPLICATED_GATE_INELIGIBLE');
  assert.deepEqual(await readFile(resolve(paths.runDir,'postflight.json')),
    originalAudit);
  const diagnosis=await diagnoseEvaluation({runDir:paths.runDir});
  assert.equal(diagnosis.state,'DIAGNOSED');
  assert.equal(diagnosis.pairs.length,1);
  assert.equal(diagnosis.issues.length,0);
  assert.equal(diagnosis.arms.length,2);
  assert.equal(JSON.parse(await readFile(resolve(paths.runDir,'diagnostics.json'),'utf8'))
    .runId,preflight.runId);
}));
