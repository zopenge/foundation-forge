import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import test from 'node:test';

import { auditOpenCodeEvidence, buildOpenCodeInvocation,
  probeOpenCodeClient, runOpenCodeArm } from '../ab-eval/opencode.mjs';

const repoRoot=resolve(import.meta.dirname,'../..');
const tempRoot=resolve(repoRoot,'.tmp');
const profile={version:'1.18.30',model:'vendor/model',variant:'high',agent:'build'};
const withArm=async fn=>{
  await mkdir(tempRoot,{recursive:true});
  const dir=await mkdtemp(resolve(tempRoot,'ab-eval-client-'));
  if(!dir.startsWith(tempRoot+sep))throw new Error('TEST_TEMP_OUTSIDE_WORKSPACE');
  try{
    const armRoot=resolve(dir,'arm');
    const fixtureRoot=resolve(armRoot,'work');
    await mkdir(fixtureRoot,{recursive:true});
    const configPath=resolve(armRoot,'opencode.json');
    const authPath=resolve(dir,'auth.json');
    await writeFile(configPath,'{}\n');
    await writeFile(authPath,'{"token":"test-only"}\n');
    await fn({armRoot,fixtureRoot,configPath,authPath});
  }finally{await rm(dir,{recursive:true,force:true});}
};

test('OpenCode invocation uses explicit model and isolated per-arm directories',()=>withArm(async paths=>{
  const spec=buildOpenCodeInvocation({executable:'opencode',profile,
    ...paths,prompt:'Fix the task.',attemptId:'pair-1-A'});
  assert.deepEqual(spec.args.slice(0,8),['run','--pure','--model','vendor/model',
    '--variant','high','--agent','build']);
  assert.equal(spec.env.OPENCODE_CONFIG,paths.configPath);
  assert.equal(spec.env.XDG_DATA_HOME,resolve(paths.armRoot,'xdg-data'));
  assert.equal(spec.env.USERPROFILE,resolve(paths.armRoot,'userprofile'));
  assert.equal(spec.args.at(-1),'Fix the task.');
}));

test('OpenCode run exports complete usage and removes the temporary credential copy',()=>withArm(async paths=>{
  const calls=[];
  const runner=async spec=>{
    calls.push(spec.args[0]);
    const copied=await readFile(resolve(paths.armRoot,'xdg-data/opencode/auth.json'),'utf8');
    assert.match(copied,/test-only/u);
    if(spec.args[0]==='run')return {status:0,stdout:JSON.stringify({
      sessionID:'ses_test',type:'step_finish',part:{type:'step-finish',
        cost:0.02,tokens:{input:100,output:20,reasoning:5,cache:{read:30,write:0}}}})+'\n',
      stderr:'',timedOut:false,outputTruncated:false};
    return {status:0,stdout:JSON.stringify({info:{id:'ses_test',version:'1.18.30',
      model:{providerID:'vendor',id:'model'}},messages:[{info:{role:'assistant',
      providerID:'vendor',modelID:'model',variant:'high',cost:0.02,
      tokens:{input:100,output:20,reasoning:5,cache:{read:30,write:0}}},
      parts:[{type:'tool',tool:'read',state:{status:'completed',input:{path:'x'}}}]}]}),
      stderr:'',timedOut:false,outputTruncated:false};
  };
  const receipt=await runOpenCodeArm({executable:'opencode',profile,
    ...paths,prompt:'Fix the task.',attemptId:'pair-1-A',timeoutMs:10000,
    processRunner:runner,evidenceRoot:resolve(paths.armRoot,'evidence')});
  assert.deepEqual(calls,['run','export']);
  assert.equal(receipt.accountingStatus,'complete');
  assert.equal(receipt.normalizedUsage.rawTotal,155);
  assert.equal(receipt.modelInvocationCount,1);
  assert.equal(receipt.rawUsage.length,1);
  assert.match(receipt.evidenceSha256.export,/^[A-F0-9]{64}$/u);
  assert.match(await readFile(resolve(paths.armRoot,'evidence/export.json'),'utf8'),/ses_test/u);
  assert.equal((await auditOpenCodeEvidence({receipt,
    evidenceRoot:resolve(paths.armRoot,'evidence'),profile})).valid,true);
  await writeFile(resolve(paths.armRoot,'evidence/export.json'),'{}');
  assert.equal((await auditOpenCodeEvidence({receipt,
    evidenceRoot:resolve(paths.armRoot,'evidence'),profile})).valid,false);
  assert.deepEqual(receipt.toolNames,['read']);
  await assert.rejects(()=>readFile(resolve(paths.armRoot,
    'xdg-data/opencode/auth.json')),{code:'ENOENT'});
}));

test('OpenCode credential copy is removed when the process fails',()=>withArm(async paths=>{
  await assert.rejects(()=>runOpenCodeArm({executable:'opencode',profile,
    ...paths,prompt:'Fix the task.',attemptId:'pair-1-A',timeoutMs:10000,
    processRunner:async()=>({status:1,stdout:'',stderr:'failed',timedOut:false})}),
  {code:'OPENCODE_RUN_FAILED'});
  await assert.rejects(()=>readFile(resolve(paths.armRoot,
    'xdg-data/opencode/auth.json')),{code:'ENOENT'});
}));

test('failed OpenCode run records bounded status metadata without stderr content',()=>withArm(async paths=>{
  const evidenceRoot=resolve(paths.armRoot,'evidence');
  await assert.rejects(()=>runOpenCodeArm({executable:'opencode',profile,
    ...paths,prompt:'Fix the task.',attemptId:'pair-1-A',timeoutMs:10000,
    evidenceRoot,processRunner:async()=>({status:1,signal:null,
      stdout:'partial',stderr:'private upstream error',timedOut:true,
      outputTruncated:false,errorCode:null})}),{code:'OPENCODE_RUN_FAILED'});
  const saved=await readFile(resolve(evidenceRoot,'run-outcome.json'),'utf8');
  assert.deepEqual(JSON.parse(saved),{schemaVersion:1,status:1,signal:null,
    timedOut:true,outputTruncated:false,errorCode:null,
    stdoutBytes:7,stderrBytes:22});
  assert.doesNotMatch(saved,/private|partial|upstream/u);
}));

test('OpenCode spawn failure is distinct from a started run failure',()=>withArm(async paths=>{
  const evidenceRoot=resolve(paths.armRoot,'evidence');
  await assert.rejects(()=>runOpenCodeArm({executable:'opencode',profile,
    ...paths,prompt:'Fix the task.',attemptId:'pair-1-A',timeoutMs:10000,
    evidenceRoot,processRunner:async()=>({status:null,signal:null,
      stdout:'',stderr:'private machine path',timedOut:false,
      outputTruncated:false,errorCode:'ENOENT'})}),
  {code:'OPENCODE_SPAWN_FAILED'});
  const saved=JSON.parse(await readFile(resolve(evidenceRoot,'run-outcome.json'),'utf8'));
  assert.equal(saved.errorCode,'ENOENT');
  assert.equal(saved.stderrBytes,20);
}));

test('observed arm binds a local transport trace to the audited receipt',()=>withArm(async paths=>{
  const upstream=createServer(async(req,res)=>{
    for await(const chunk of req)void chunk;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('data: {"usage":{"prompt_tokens":17,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening');
  try{
    const upstreamBaseURL=`http://127.0.0.1:${upstream.address().port}/v1`;
    await writeFile(paths.configPath,JSON.stringify({provider:{vendor:{
      options:{baseURL:upstreamBaseURL}}}}));
    const runner=async spec=>{
      if(spec.args[0]==='debug'){
        const config=JSON.parse(await readFile(spec.env.OPENCODE_CONFIG,'utf8'));
        const inline=JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(inline.provider.vendor.options.baseURL,
          config.provider.vendor.options.baseURL);
        return {status:0,stdout:JSON.stringify(config)};
      }
      if(spec.args[0]==='run'){
        const observed=JSON.parse(await readFile(spec.env.OPENCODE_CONFIG,'utf8'));
        const endpoint=observed.provider.vendor.options.baseURL;
        assert.match(endpoint,/^http:\/\/127\.0\.0\.1:/u);
        const response=await globalThis.fetch(`${endpoint}/chat/completions`,{
          method:'POST',headers:{authorization:'Bearer fake-secret'},
          body:'private prompt'});
        assert.equal(response.status,200);
        await response.text();
        return {status:0,stdout:JSON.stringify({sessionID:'ses_observed',
          type:'step_finish',part:{type:'step-finish',cost:0,
            tokens:{input:17,output:2,reasoning:0,
              cache:{read:0,write:0}}}})+'\n'};
      }
      return {status:0,stdout:JSON.stringify({info:{id:'ses_observed',
        version:'1.18.30',model:{providerID:'vendor',id:'model'}},
      messages:[{info:{role:'assistant',providerID:'vendor',modelID:'model',
        variant:'high',cost:0,tokens:{input:17,output:2,reasoning:0,
          cache:{read:0,write:0}}},parts:[]}]})};
    };
    const evidenceRoot=resolve(paths.armRoot,'evidence');
    const receipt=await runOpenCodeArm({executable:'opencode',profile,
      ...paths,prompt:'Fix the task.',attemptId:'pair-1-A',timeoutMs:10000,
      processRunner:runner,evidenceRoot,transportObservation:true});
    assert.equal(receipt.transportObservation.requestCount,1);
    const saved=await readFile(resolve(evidenceRoot,'transport.json'),'utf8');
    assert.doesNotMatch(saved,/private prompt|fake-secret/u);
    assert.match(saved,/"prompt_tokens": 17/u);
    assert.equal((await auditOpenCodeEvidence({receipt,evidenceRoot,profile,
      configPath:paths.configPath})).valid,true);
    await writeFile(resolve(evidenceRoot,'transport.json'),'{}');
    assert.equal((await auditOpenCodeEvidence({receipt,evidenceRoot,profile,
      configPath:paths.configPath})).valid,false);
  }finally{
    await new Promise((resolvePromise,reject)=>upstream.close(error=>
      error?reject(error):resolvePromise()));
  }
}));

test('observed arm blocks before a model call when the client ignores the proxy config',()=>withArm(async paths=>{
  await writeFile(paths.configPath,JSON.stringify({provider:{vendor:{
    options:{baseURL:'https://example.com/v1'}}}}));
  let modelCalls=0;
  await assert.rejects(runOpenCodeArm({executable:'opencode',profile,
    ...paths,prompt:'Fix the task.',attemptId:'pair-1-A',
    evidenceRoot:resolve(paths.armRoot,'evidence'),transportObservation:true,
    processRunner:async spec=>{
      if(spec.args[0]==='debug')return {status:0,stdout:JSON.stringify({
        provider:{vendor:{options:{baseURL:'https://example.com/v1'}}}})};
      modelCalls+=1;
      return {status:0,stdout:''};
    }}),{code:'TRANSPORT_CONFIG_NOT_EFFECTIVE'});
  assert.equal(modelCalls,0);
}));

test('observed arm records timeout separately from observer shutdown',()=>withArm(async paths=>{
  await writeFile(paths.configPath,JSON.stringify({provider:{vendor:{
    options:{baseURL:'https://example.com/v1'}}}}));
  const evidenceRoot=resolve(paths.armRoot,'evidence');
  await assert.rejects(runOpenCodeArm({executable:'fake-opencode',profile,
    ...paths,prompt:'Fix the task.',attemptId:'pair-1-A',timeoutMs:600000,
    evidenceRoot,transportObservation:true,processRunner:async spec=>{
      if(spec.args[0]==='debug'){
        const config=JSON.parse(await readFile(spec.env.OPENCODE_CONFIG,'utf8'));
        return {status:0,stdout:JSON.stringify(config)};
      }
      return {status:1,signal:'SIGKILL',stdout:'',stderr:'',timedOut:true,
        outputTruncated:false,errorCode:null};
    }}),{code:'OPENCODE_RUN_FAILED'});
  const saved=JSON.parse(await readFile(resolve(evidenceRoot,'transport.json'),'utf8'));
  assert.deepEqual(saved.events.map(event=>event.type),
    ['ARM_TIMEOUT','OBSERVER_CLOSING','OBSERVER_CLOSED']);
  assert.ok(saved.events.every(event=>/^\d{4}-\d\d-\d\dT/u.test(event.at)));
  assert.deepEqual(saved.records,[]);
}));

test('model-disabled client doctor checks isolated MCP connection',async()=>{
  const calls=[];
  const result=await probeOpenCodeClient({executable:'opencode',tempRoot,
    processRunner:async spec=>{
      calls.push(spec.args[0]);
      if(spec.args[0]==='--version')return {status:0,stdout:'1.18.30\n'};
      assert.deepEqual(spec.args,['mcp','list']);
      const config=JSON.parse(await readFile(spec.env.OPENCODE_CONFIG,'utf8'));
      assert.equal(config.mcp.ab_probe.command[0],process.execPath);
      assert.equal(config.mcp.ab_probe.enabled,true);
      return {status:0,stdout:'ab_probe connected\n'};
    }});
  assert.deepEqual(calls,['--version','mcp']);
  assert.equal(result.state,'CLIENT_CONNECTED');
  assert.equal(result.modelCalls,0);
});
