import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { main as abEvalMain } from '../ab-eval.mjs';
import { diagnoseEvaluation } from '../ab-eval/diagnostics.mjs';

const tempRoot=resolve(import.meta.dirname,'../../.tmp');
const writeJson=(path,value)=>writeFile(path,JSON.stringify(value));
test('diagnosis extracts token regression and repeated missing scope evidence',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-diagnose-'));
  try{
    await mkdir(resolve(root,'journal'));
    const manifestPath=resolve(root,'pack.json');
    await writeJson(manifestPath,{allowedTools:{A:['read'],
      C:['repository_context_investigate']}});
    const arms=['A','C'].map(arm=>({attemptId:`pair-1-${arm}`,
      pairId:'pair-1',arm,armRoot:resolve(root,arm)}));
    await writeJson(resolve(root,'preflight.json'),{runId:'diagnostic-test',
      manifestPath,arms});
    await writeJson(resolve(root,'postflight.json'),{runId:'diagnostic-test',
      schedulerState:'stopped',plannedPairs:1,completePairs:1,
      modelCalls:3,knownCostUsd:0.1,issues:[],pairRows:[{pairId:'pair-1',
        complete:true,qualityPass:true,tokenPass:false,
        aRawTotal:100,cRawTotal:120}]});
    for(const arm of arms){
      await mkdir(resolve(arm.armRoot,'evidence'),{recursive:true});
      await writeJson(resolve(root,'journal',`${arm.attemptId}.settled.json`),{
        normalizedUsage:{rawTotal:arm.arm==='A'?100:120},
        rawUsage:arm.arm==='A'
          ?[{input:90,output:10,reasoning:0,cacheRead:0,cacheWrite:0}]
          :[{input:50,output:10,reasoning:0,cacheRead:0,cacheWrite:0},
            {input:50,output:10,reasoning:0,cacheRead:0,cacheWrite:0}],
        modelInvocationCount:arm.arm==='A'?1:2,costUsd:0.05,qualityPass:true,
        accountingStatus:'complete',toolNames:arm.arm==='C'
          ?['repository_context_investigate','repository_context_continue']:['read']});
      const tool={type:'tool',tool:'repository_context_investigate',state:{
        status:'completed',input:{scope:'src',query:'path'},
        output:'{"reason":"REQUESTED_SCOPE_MISSING"}'}};
      const benign={type:'tool',tool:'read',state:{status:'completed',
        input:{path:'src/file.ts'},output:'{"reason":"complete"}'}};
      const failedContinue={type:'tool',tool:'repository_context_continue',
        state:{status:'error',input:{cursor:'invalid'},
          error:'{"code":"CONTINUATION_CURSOR_UNKNOWN","message":"bad cursor"}'}};
      await writeJson(resolve(arm.armRoot,'evidence/export.json'),{
        messages:arm.arm==='C'
          ?[{info:{role:'assistant'},parts:[tool,tool]},
            {info:{role:'assistant'},parts:[failedContinue]}]
          :[{info:{role:'assistant'},parts:[benign]}]});
    }
    const report=await diagnoseEvaluation({runDir:root});
    assert.deepEqual(new Set(report.issues.map(item=>item.code)),new Set([
      'TOOL_REASON','REPEATED_TOOL_INPUT','PAIR_TOKEN_REGRESSION',
      'C_MORE_MODEL_CALLS','TOOL_BOUNDARY','TOOL_ERROR']));
    assert.equal(report.pairs[0].delta,20);
    assert.equal(report.pairs[0].modelCallDelta,1);
    assert.equal(report.arms[1].tools[0].input.scope,'src');
    assert.equal(report.issues.filter(issue=>issue.code==='TOOL_REASON').length,2);
    assert.deepEqual(report.issues.find(issue=>issue.code==='TOOL_BOUNDARY').tools,
      ['repository_context_continue']);
    assert.equal(report.issues.find(issue=>issue.code==='TOOL_ERROR').reason,
      'CONTINUATION_CURSOR_UNKNOWN');
    assert.match(await readFile(resolve(root,'diagnostics.md'),'utf8'),
      /TOOL_BOUNDARY: pair-1-C repository_context_continue/u);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnosis distinguishes native tool inputs and reports context size',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-diagnose-inputs-'));
  try{
    await mkdir(resolve(root,'journal'));
    const arm={attemptId:'pair-1-A',pairId:'pair-1',arm:'A',
      armRoot:resolve(root,'A')};
    await mkdir(resolve(arm.armRoot,'evidence'),{recursive:true});
    await writeJson(resolve(root,'preflight.json'),{runId:'input-test',arms:[arm]});
    await writeJson(resolve(root,'postflight.json'),{runId:'input-test',
      schedulerState:'stopped',plannedPairs:1,completePairs:0,
      modelCalls:1,knownCostUsd:0,issues:[],pairRows:[{pairId:'pair-1',
        complete:false,qualityPass:false,tokenPass:false,
        aRawTotal:null,cRawTotal:null}]});
    await writeJson(resolve(root,'journal',`${arm.attemptId}.settled.json`),{
      normalizedUsage:{rawTotal:12},rawUsage:[{input:10,output:2,
        reasoning:0,cacheRead:0,cacheWrite:0}],
      modelInvocationCount:1,costUsd:0,qualityPass:true,
      accountingStatus:'complete'});
    const tool=(name,input,output='ok')=>({type:'tool',tool:name,
      state:{status:'completed',input,output}});
    await writeJson(resolve(arm.armRoot,'evidence/export.json'),{
      messages:[{info:{role:'assistant'},parts:[
        tool('read',{filePath:'src/one.ts'},'<content>export class Error {}</content>'),
        tool('read',{filePath:'src/two.ts'},'defg'),
        tool('grep',{pattern:'alpha',path:'src'},'match'),
        tool('grep',{pattern:'beta',path:'src'},'match'),
        tool('todowrite',{todos:[{content:'first'}]},'ok'),
        tool('todowrite',{todos:[{content:'second'}]},'ok'),
      ]}]});
    const report=await diagnoseEvaluation({runDir:root});
    assert.equal(report.issues.filter(issue=>issue.code==='REPEATED_TOOL_INPUT').length,0);
    assert.equal(report.issues.filter(issue=>issue.code==='TOOL_REASON').length,0);
    assert.equal(report.arms[0].tools[0].input.path,'src/one.ts');
    assert.equal(report.arms[0].tools[0].input.maxBytes,null);
    assert.equal(report.arms[0].tools[2].input.query,'alpha');
    assert.equal(report.arms[0].toolOutputBytes,
      Buffer.byteLength('<content>export class Error {}</content>')+4+5+5+2+2);
    assert.equal(report.arms[0].firstInputTokens,10);
    assert.match(await readFile(resolve(root,'diagnostics.md'),'utf8'),
      /\| pair-1 \| — \| — \| — \| 1\/— \| — \| — \| 未运行 \| 未运行 \|/u);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnosis preserves turn accounting and tool event context',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-diagnose-turns-'));
  try{
    await mkdir(resolve(root,'journal'));
    const arm={attemptId:'pair-1-C',pairId:'pair-1',arm:'C',
      armRoot:resolve(root,'C')};
    await mkdir(resolve(arm.armRoot,'evidence'),{recursive:true});
    await writeJson(resolve(root,'preflight.json'),{runId:'turn-test',arms:[arm]});
    await writeJson(resolve(root,'postflight.json'),{runId:'turn-test',
      schedulerState:'complete',plannedPairs:1,completePairs:0,
      modelCalls:3,knownCostUsd:0,issues:[],pairRows:[{pairId:'pair-1',
        complete:false,qualityPass:false,tokenPass:false,
        aRawTotal:null,cRawTotal:null}]});
    await writeJson(resolve(root,'journal',`${arm.attemptId}.settled.json`),{
      normalizedUsage:{rawTotal:140},modelInvocationCount:3,
      rawUsage:[
        {input:10,cacheRead:20,cacheWrite:3,output:4,reasoning:5},
        {input:12,cacheRead:30,cacheWrite:0,output:6,reasoning:1},
        {input:9,cacheRead:35,cacheWrite:0,output:4,reasoning:1},
      ],costUsd:0,qualityPass:true,accountingStatus:'complete',
      toolNames:['repository_context_investigate','formal_task_run_public_test',
        'todowrite','formal_task_replace_text']});
    await writeJson(resolve(arm.armRoot,'evidence/export.json'),{messages:[
      {info:{role:'user'},parts:[{type:'text',text:'task'}]},
      {info:{role:'assistant'},parts:[{type:'tool',
        tool:'repository_context_investigate',state:{status:'completed',
          input:{query:'find source',maxBytes:30000},output:JSON.stringify({
            truncated:true,internallyTruncated:true,evidence:[
              {path:'src/part.ts',wholeFile:false},
              {path:'src/all.ts',wholeFile:true},
            ]})}}]},
      {info:{role:'assistant'},parts:[
        {type:'tool',tool:'formal_task_run_public_test',state:{
          status:'completed',input:{},output:JSON.stringify({exitCode:1})}},
        {type:'tool',tool:'todowrite',state:{status:'error',
          input:{todos:[]},error:'缺少状态'}},
      ]},
      {info:{role:'assistant'},parts:[{type:'tool',
        tool:'formal_task_replace_text',state:{status:'completed',
          input:{path:'src/part.ts'},output:JSON.stringify({
            publicTest:{exitCode:0}})}}]},
    ]});
    const report=await diagnoseEvaluation({runDir:root});
    const result=report.arms[0];
    assert.deepEqual(result.turns.map(turn=>[turn.rawInput,turn.rawOutput,
      turn.rawTotal]),[[33,9,42],[42,7,49],[44,5,49]]);
    assert.deepEqual(result.turns[0],{
      index:1,input:10,cacheRead:20,cacheWrite:3,output:4,reasoning:5,
      rawInput:33,rawOutput:9,rawTotal:42,exportPriorPartsJsonBytes:31,
      toolNames:['repository_context_investigate']});
    assert.ok(result.turns[1].exportPriorPartsJsonBytes>31);
    assert.deepEqual(result.turns.map(turn=>turn.toolNames),[
      ['repository_context_investigate'],
      ['formal_task_run_public_test','todowrite'],
      ['formal_task_replace_text']]);
    assert.equal(result.tools[0].turnIndex,1);
    assert.equal(result.tools[0].input.maxBytes,30000);
    assert.deepEqual(result.tools[0].response,{
      truncated:true,internallyTruncated:true,
      wholeFilePaths:['src/all.ts'],partialFilePaths:['src/part.ts']});
    assert.equal(result.tools[1].beforeFirstEdit,true);
    assert.equal(result.preEditPublicTests,1);
    assert.equal(result.tools[2].errorBytes,12);
    assert.equal(result.tools[3].beforeFirstEdit,false);
    const markdown=await readFile(resolve(root,'diagnostics.md'),'utf8');
    assert.match(markdown,/\| pair-1-C \| 2 \| 12 \| 30 \| 0 \| 6 \| 1 \| 42 \| 7 \| 49 \|/u);
    assert.match(markdown,/修改前公开测试：1/u);
    assert.match(markdown,/完整文件证据：1；片段证据：1/u);
    assert.doesNotMatch(markdown,/缺少状态/u);
    const originalJson=await readFile(resolve(root,'diagnostics.json'),'utf8');
    await assert.rejects(diagnoseEvaluation({runDir:root}),{code:'EEXIST'});
    const reportDir=resolve(root,'new-diagnostics');
    await diagnoseEvaluation({runDir:root,reportDir});
    assert.equal(await readFile(resolve(root,'diagnostics.json'),'utf8'),originalJson);
    assert.match(await readFile(resolve(reportDir,'diagnostics.md'),'utf8'),
      /导出历史字节/u);
    await assert.rejects(diagnoseEvaluation({runDir:root,reportDir}),
      {code:'EEXIST'});
    await assert.rejects(diagnoseEvaluation({runDir:root,
      reportDir:resolve('docs','forbidden-diagnostics')}),
    {code:'DIAGNOSTIC_OUTPUT_OUTSIDE_TEMP'});
    const cliDir=resolve(root,'cli-diagnostics');
    const cli=await abEvalMain(['diagnose','--run-dir',root,
      '--report-dir',cliDir]);
    assert.equal(cli.path,resolve(cliDir,'diagnostics.json'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnosis does not align tools to mismatched usage turns',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-diagnose-mismatch-'));
  try{
    await mkdir(resolve(root,'journal'));
    const arm={attemptId:'pair-1-C',pairId:'pair-1',arm:'C',
      armRoot:resolve(root,'C')};
    await mkdir(resolve(arm.armRoot,'evidence'),{recursive:true});
    await writeJson(resolve(root,'preflight.json'),{runId:'mismatch-test',arms:[arm]});
    await writeJson(resolve(root,'postflight.json'),{runId:'mismatch-test',
      schedulerState:'complete',plannedPairs:1,completePairs:0,
      modelCalls:2,knownCostUsd:0,issues:[],pairRows:[]});
    await writeJson(resolve(root,'journal',`${arm.attemptId}.settled.json`),{
      normalizedUsage:{rawTotal:23},modelInvocationCount:2,
      rawUsage:[
        {input:10,cacheRead:0,cacheWrite:0,output:1,reasoning:0},
        {input:10,cacheRead:0,cacheWrite:0,output:2,reasoning:0},
      ],costUsd:0,qualityPass:true,accountingStatus:'complete',
      toolNames:['repository_context_investigate']});
    await writeJson(resolve(arm.armRoot,'evidence/export.json'),{messages:[
      {info:{role:'assistant'},parts:[{type:'tool',
        tool:'repository_context_investigate',state:{status:'completed',
          input:{query:'find'},output:'{}'}}]},
    ]});
    const report=await diagnoseEvaluation({runDir:root});
    assert.equal(report.arms[0].turns[0].exportPriorPartsJsonBytes,null);
    assert.deepEqual(report.arms[0].turns.map(turn=>turn.rawTotal),[11,12]);
    assert.deepEqual(report.arms[0].turns.map(turn=>turn.toolNames),[[],[]]);
    assert.equal(report.arms[0].tools[0].turnIndex,null);
    assert.deepEqual(report.issues.find(issue=>issue.code==='TURN_ALIGNMENT_MISMATCH'),
      {code:'TURN_ALIGNMENT_MISMATCH',attemptId:'pair-1-C',
        usageTurns:2,exportTurns:1});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnosis joins audited transport sizes with model turns without storing bodies',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-transport-diagnose-'));
  try{
    const arm={attemptId:'pair-1-A',pairId:'pair-1',arm:'A',
      armRoot:resolve(root,'A')};
    await mkdir(resolve(root,'journal'));
    await mkdir(resolve(arm.armRoot,'evidence'),{recursive:true});
    await writeJson(resolve(root,'preflight.json'),{runId:'transport-test',arms:[arm]});
    await writeJson(resolve(root,'postflight.json'),{runId:'transport-test',
      schedulerState:'complete',plannedPairs:1,completePairs:0,
      modelCalls:1,knownCostUsd:0,issues:[],pairRows:[]});
    const transport=JSON.stringify({schemaVersion:1,records:[{index:1,
      requestBytes:33524,requestSha256:'A'.repeat(64),responseStatus:200,
      responseBytes:549,usage:{prompt_tokens:10906,completion_tokens:200},
      requestShape:{format:'json-object',topLevelFieldCount:4,
        messageCount:3,messageBytes:8721,messageItemBytes:[100,500,8121],
        toolCount:18,toolBytes:20100,toolItemBytes:[700],
        otherBytes:4703,itemSizesTruncated:false},
      errorCode:null}]});
    await writeFile(resolve(arm.armRoot,'evidence/transport.json'),transport);
    await writeJson(resolve(root,'journal',`${arm.attemptId}.settled.json`),{
      normalizedUsage:{rawTotal:11106},modelInvocationCount:1,
      rawUsage:[{input:10906,cacheRead:0,cacheWrite:0,
        output:181,reasoning:19}],costUsd:0,qualityPass:true,
      accountingStatus:'complete',toolNames:[],
      evidenceSha256:{transport:createHash('sha256').update(transport)
        .digest('hex').toUpperCase()},transportObservation:{requestCount:1}});
    await writeJson(resolve(arm.armRoot,'evidence/export.json'),{
      messages:[{info:{role:'assistant'},parts:[]}]});
    const report=await diagnoseEvaluation({runDir:root});
    assert.deepEqual(report.arms[0].transportRequests,[{index:1,
      requestBytes:33524,requestSha256:'A'.repeat(64),responseStatus:200,
      responseBytes:549,providerInputTokens:10906,
      providerOutputTokens:200,cacheReadTokens:null,
      rawInput:10906,rawOutput:200,errorCode:null,
      requestShape:{format:'json-object',topLevelFieldCount:4,
        messageCount:3,messageBytes:8721,messageItemBytes:[100,500,8121],
        toolCount:18,toolBytes:20100,toolItemBytes:[700],
        otherBytes:4703,itemSizesTruncated:false}}]);
    assert.match(await readFile(resolve(root,'diagnostics.md'),'utf8'),
      /\| pair-1-A \| 1 \| 33524 \| 3 \| 8721 \| 18 \| 20100 \| 4703 \| 10906 \| 10906 \| 200 \| 200 \|/u);
    const changed=JSON.parse(transport);
    changed.records.push({...changed.records[0],index:2});
    await writeJson(resolve(arm.armRoot,'evidence/transport.json'),changed);
    const second=await diagnoseEvaluation({runDir:root,
      reportDir:resolve(root,'second')});
    assert.ok(second.issues.some(issue=>issue.code==='TRANSPORT_EVIDENCE_DRIFT'));
    assert.deepEqual(second.arms[0].transportRequests,[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnosis retains HTTP errors and usage-bearing extra requests across settled and failed arms',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-transport-layers-'));
  try{
    const settled={attemptId:'pair-1-A',pairId:'pair-1',arm:'A',
      armRoot:resolve(root,'A')};
    const failed={attemptId:'pair-1-C',pairId:'pair-1',arm:'C',
      armRoot:resolve(root,'C')};
    await mkdir(resolve(root,'journal'));
    for(const arm of [settled,failed])
      await mkdir(resolve(arm.armRoot,'evidence'),{recursive:true});
    await writeJson(resolve(root,'preflight.json'),{runId:'layers',
      arms:[settled,failed]});
    await writeJson(resolve(root,'postflight.json'),{runId:'layers',
      schedulerState:'stopped',plannedPairs:1,completePairs:0,
      modelCalls:1,knownCostUsd:0,issues:[],pairRows:[]});
    const settledTransport=JSON.stringify({schemaVersion:1,events:[],records:[
      {index:1,requestBytes:2,responseStatus:502,responseBytes:9,
        startedAt:'2026-09-25T00:00:00.000Z',durationMs:12.5,
        responseHeaderMs:5.25,usage:null,errorCode:null,
        terminalEvent:'UPSTREAM_HTTP_ERROR'},
      {index:2,requestBytes:2,responseStatus:200,responseBytes:9,
        usage:{prompt_tokens:13,completion_tokens:0},errorCode:null,
        requestSha256:'B'.repeat(64),terminalEvent:'UPSTREAM_SSE_ERROR',
        sseErrorCode:'UPSTREAM_SSE_ERROR'},
      {index:3,requestBytes:2,responseStatus:200,responseBytes:9,
        usage:{prompt_tokens:13,completion_tokens:2},errorCode:null,
        requestSha256:'B'.repeat(64),terminalEvent:'COMPLETED'},
    ]});
    await writeFile(resolve(settled.armRoot,'evidence/transport.json'),
      settledTransport);
    await writeJson(resolve(root,'journal',`${settled.attemptId}.settled.json`),{
      normalizedUsage:{rawTotal:15},modelInvocationCount:1,
      rawUsage:[{input:13,cacheRead:0,cacheWrite:0,output:2,reasoning:0}],
      costUsd:0,qualityPass:true,accountingStatus:'complete',toolNames:[],
      evidenceSha256:{transport:createHash('sha256')
        .update(settledTransport).digest('hex').toUpperCase()},
      transportObservation:{requestCount:3}});
    await writeJson(resolve(settled.armRoot,'evidence/export.json'),{
      messages:[{info:{role:'assistant'},parts:[]}]});
    await writeJson(resolve(failed.armRoot,'evidence/transport.json'),{
      schemaVersion:1,events:[{type:'ARM_TIMEOUT',at:'2026-09-25T00:00:00.000Z'},
        {type:'OBSERVER_CLOSING',at:'2026-09-25T00:00:00.001Z'},
        {type:'OBSERVER_CLOSED',at:'2026-09-25T00:00:00.002Z'}],
      records:[
        {index:1,requestBytes:2,responseStatus:502,responseBytes:0,
          usage:null,errorCode:null,terminalEvent:'UPSTREAM_HTTP_ERROR'},
        {index:2,requestBytes:2,responseStatus:null,responseBytes:0,
          usage:null,errorCode:'UPSTREAM_TRANSPORT_FAILED',
          sseErrorCode:'private unsafe error'},
        {index:3,requestBytes:2,responseStatus:200,responseBytes:4,
          usage:null,errorCode:null,terminalEvent:'OBSERVER_CANCEL',
          cancelSource:'observer',sseErrorCode:'UPSTREAM_SSE_ERROR'},
      ]});
    const report=await diagnoseEvaluation({runDir:root});
    assert.equal(report.arms[0].transportRequests.length,3);
    assert.equal(report.arms[0].transportRequests[0].durationMs,12.5);
    assert.equal(report.arms[0].transportRequests[0].responseHeaderMs,5.25);
    assert.equal(report.arms[0].transportRequests[1].sseErrorCode,
      'UPSTREAM_SSE_ERROR');
    assert.equal(report.arms[0].transportRequests[1].terminalEvent,
      'UPSTREAM_SSE_ERROR');
    assert.equal(report.issues.filter(issue=>issue.code==='UPSTREAM_SSE_ERROR').length,2);
    assert.doesNotMatch(JSON.stringify(report),/private unsafe error/u);
    assert.deepEqual(report.arms[0].transportRequests.map(row=>row.rawInput),
      [null,null,null]);
    assert.equal(report.arms[1].transportRequests[0].responseStatus,502);
    assert.equal(report.arms[1].transportRequests[2].cancelSource,'observer');
    assert.ok(report.issues.some(issue=>issue.code==='OBSERVER_CANCEL'
      &&issue.attemptId==='pair-1-C'));
    assert.deepEqual(report.arms[1].transportEvents.map(event=>event.type),
      ['ARM_TIMEOUT','OBSERVER_CLOSING','OBSERVER_CLOSED']);
    assert.equal(report.arms[1].transportEvidenceStatus,'unaudited');
    assert.equal(report.issues.filter(issue=>issue.code==='UPSTREAM_HTTP_ERROR').length,2);
    assert.ok(report.issues.some(issue=>issue.code==='UPSTREAM_TRANSPORT_FAILED'
      &&issue.attemptId==='pair-1-C'));
    assert.ok(report.issues.some(issue=>issue.code==='ARM_TIMEOUT'
      &&issue.attemptId==='pair-1-C'));
    assert.deepEqual(report.issues.find(issue=>
      issue.code==='TRANSPORT_USAGE_REQUEST_OVERAGE'),{
      code:'TRANSPORT_USAGE_REQUEST_OVERAGE',attemptId:'pair-1-A',
      requests:3,usageRequests:2,usageTurns:1,indexes:[2,3]});
    assert.deepEqual(report.issues.find(issue=>
      issue.code==='TRANSPORT_NUMERIC_TURN_CANDIDATES'),{
      code:'TRANSPORT_NUMERIC_TURN_CANDIDATES',attemptId:'pair-1-A',
      candidates:[{turnIndex:1,requestIndex:3}],
      unmatchedRequestIndexes:[1,2],
      sameRequestSha256Pairs:[{fromIndex:2,toIndex:3}]});
    assert.match(await readFile(resolve(root,'diagnostics.md'),'utf8'),
      /UPSTREAM_HTTP_ERROR: pair-1-A/u);
    assert.match(await readFile(resolve(root,'diagnostics.md'),'utf8'),
      /UPSTREAM_SSE_ERROR: pair-1-C/u);
    const legacy=JSON.parse(await readFile(resolve(failed.armRoot,
      'evidence/transport.json'),'utf8'));
    legacy.events=[];
    await writeJson(resolve(failed.armRoot,'evidence/transport.json'),legacy);
    await writeJson(resolve(failed.armRoot,'evidence/run-outcome.json'),{
      schemaVersion:1,status:1,timedOut:true});
    const legacyReport=await diagnoseEvaluation({runDir:root,
      reportDir:resolve(root,'legacy-report')});
    assert.ok(legacyReport.issues.some(issue=>issue.code==='ARM_TIMEOUT'
      &&issue.attemptId==='pair-1-C'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnosis separates HTTP-only request overage from usage overage',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-http-overage-'));
  try{
    const arm={attemptId:'pair-1-A',pairId:'pair-1',arm:'A',
      armRoot:resolve(root,'A')};
    await mkdir(resolve(root,'journal'));
    await mkdir(resolve(arm.armRoot,'evidence'),{recursive:true});
    await writeJson(resolve(root,'preflight.json'),{runId:'http-overage',
      arms:[arm]});
    await writeJson(resolve(root,'postflight.json'),{runId:'http-overage',
      schedulerState:'complete',plannedPairs:1,completePairs:0,
      modelCalls:2,knownCostUsd:0,issues:[],pairRows:[]});
    const transport=JSON.stringify({schemaVersion:1,records:[
      {index:1,responseStatus:200,usage:{prompt_tokens:10,
        completion_tokens:1},errorCode:null},
      {index:2,responseStatus:502,usage:null,errorCode:null,
        requestSha256:'C'.repeat(64)},
      {index:3,responseStatus:200,usage:{prompt_tokens:12,
        completion_tokens:1},errorCode:null,
        requestSha256:'C'.repeat(64)},
    ]});
    await writeFile(resolve(arm.armRoot,'evidence/transport.json'),transport);
    await writeJson(resolve(root,'journal',`${arm.attemptId}.settled.json`),{
      normalizedUsage:{rawTotal:24},modelInvocationCount:2,
      rawUsage:[{input:10,cacheRead:0,cacheWrite:0,output:1,reasoning:0},
        {input:12,cacheRead:0,cacheWrite:0,output:1,reasoning:0}],
      costUsd:0,qualityPass:true,accountingStatus:'complete',
      evidenceSha256:{transport:createHash('sha256').update(transport)
        .digest('hex').toUpperCase()},transportObservation:{requestCount:3}});
    await writeJson(resolve(arm.armRoot,'evidence/export.json'),{
      messages:[{info:{role:'assistant'},parts:[]},
        {info:{role:'assistant'},parts:[]}]});
    const report=await diagnoseEvaluation({runDir:root});
    assert.deepEqual(report.issues.find(issue=>
      issue.code==='TRANSPORT_REQUEST_OVERAGE_NO_USAGE'),{
      code:'TRANSPORT_REQUEST_OVERAGE_NO_USAGE',
      attemptId:arm.attemptId,requests:3,usageRequests:2,
      usageTurns:2,indexes:[2]});
    assert.ok(report.issues.some(issue=>issue.code==='UPSTREAM_HTTP_ERROR'
      &&issue.index===2));
    assert.ok(!report.issues.some(issue=>
      issue.code==='TRANSPORT_USAGE_REQUEST_OVERAGE'));
    assert.deepEqual(report.arms[0].transportRequests.map(row=>row.rawInput),
      [null,null,null]);
    assert.deepEqual(report.issues.find(issue=>
      issue.code==='TRANSPORT_NUMERIC_TURN_CANDIDATES'),{
      code:'TRANSPORT_NUMERIC_TURN_CANDIDATES',attemptId:arm.attemptId,
      candidates:[{turnIndex:1,requestIndex:1},
        {turnIndex:2,requestIndex:3}],unmatchedRequestIndexes:[2],
      sameRequestSha256Pairs:[{fromIndex:2,toIndex:3}]});
    const ambiguous=JSON.parse(transport);
    ambiguous.records[2].usage={prompt_tokens:10,completion_tokens:1};
    const ambiguousBytes=JSON.stringify(ambiguous);
    await writeFile(resolve(arm.armRoot,'evidence/transport.json'),
      ambiguousBytes);
    const receiptPath=resolve(root,'journal',`${arm.attemptId}.settled.json`);
    const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
    receipt.rawUsage[1].input=10;
    receipt.normalizedUsage.rawTotal=22;
    receipt.evidenceSha256.transport=createHash('sha256')
      .update(ambiguousBytes).digest('hex').toUpperCase();
    await writeJson(receiptPath,receipt);
    const ambiguousReport=await diagnoseEvaluation({runDir:root,
      reportDir:resolve(root,'ambiguous')});
    assert.ok(!ambiguousReport.issues.some(issue=>
      issue.code==='TRANSPORT_NUMERIC_TURN_CANDIDATES'));
  }finally{await rm(root,{recursive:true,force:true});}
});
