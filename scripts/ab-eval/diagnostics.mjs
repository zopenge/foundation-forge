import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const fail=code=>Object.assign(new Error(code),{code});
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const bounded=value=>typeof value==='string'?value.slice(0,240):null;
const transportEventTypes=new Set(['ARM_TIMEOUT','OBSERVER_CLOSING',
  'OBSERVER_CLOSED']);
const requestEvents=new Set(['COMPLETED','UPSTREAM_HTTP_ERROR',
  'UPSTREAM_CONNECTION_ERROR','UPSTREAM_STREAM_ERROR','UPSTREAM_SSE_ERROR','DOWNSTREAM_CANCEL',
  'OBSERVER_CANCEL','OBSERVER_ERROR','REQUEST_TOO_LARGE']);
const errorClasses=new Set(['AbortError','TypeError','RangeError',
  'SyntaxError','Error']);
const transportErrorCodes=new Set(['REQUEST_TOO_LARGE',
  'UPSTREAM_TRANSPORT_FAILED']);
const safeTimestamp=value=>typeof value==='string'
  &&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)
  ?value:null;
const safeDuration=value=>typeof value==='number'
  &&Number.isFinite(value)&&value>=0?value:null;
const numericTurnCandidates=(turns,requests)=>{
  const candidates=turns.map((turn,index)=>requests.filter(row=>
    Number.isSafeInteger(row.providerInputTokens)
    &&Number.isSafeInteger(row.providerOutputTokens)
    &&row.providerInputTokens===turn.rawInput
    &&row.providerOutputTokens===turn.rawOutput)
    .map(row=>({turnIndex:index+1,requestIndex:row.index})));
  if(candidates.some(rows=>rows.length!==1))return null;
  const matched=candidates.map(([row])=>row);
  if(matched.some((row,index)=>index>0
    &&row.requestIndex<=matched[index-1].requestIndex))return null;
  const matchedIndexes=new Set(matched.map(row=>row.requestIndex));
  const unmatched=requests.filter(row=>!matchedIndexes.has(row.index));
  const sameRequestSha256Pairs=unmatched.flatMap(row=>{
    if(!/^[A-F0-9]{64}$/u.test(row.requestSha256??''))return [];
    return requests.filter(other=>matchedIndexes.has(other.index)
      &&other.index>row.index
      &&other.requestSha256===row.requestSha256)
      .map(other=>({fromIndex:row.index,toIndex:other.index}));
  });
  return {candidates:matched,
    unmatchedRequestIndexes:unmatched.map(row=>row.index),
    sameRequestSha256Pairs};
};
const safeRequestShape=value=>{
  if(value?.format!=='json-object')return null;
  const scalars=['topLevelFieldCount','messageCount','messageBytes',
    'toolCount','toolBytes','otherBytes'];
  if(!scalars.every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)
    ||typeof value.itemSizesTruncated!=='boolean')return null;
  const arrays=['messageItemBytes','toolItemBytes'];
  if(!arrays.every(key=>Array.isArray(value[key])&&value[key].length<=128
    &&value[key].every(item=>Number.isSafeInteger(item)&&item>=0)))return null;
  return {format:'json-object',
    topLevelFieldCount:value.topLevelFieldCount,
    messageCount:value.messageCount,messageBytes:value.messageBytes,
    messageItemBytes:value.messageItemBytes,
    toolCount:value.toolCount,toolBytes:value.toolBytes,
    toolItemBytes:value.toolItemBytes,otherBytes:value.otherBytes,
    itemSizesTruncated:value.itemSizesTruncated};
};
const toolOutputBytes=value=>value===undefined?0:Buffer.byteLength(
  typeof value==='string'?value:JSON.stringify(value),'utf8');
const usageTurn=(row,index,toolNames,exportPriorPartsJsonBytes)=>{
  const rawInput=row.input+row.cacheRead+row.cacheWrite;
  const rawOutput=row.output+row.reasoning;
  return {index:index+1,input:row.input,cacheRead:row.cacheRead,
    cacheWrite:row.cacheWrite,output:row.output,reasoning:row.reasoning,
    rawInput,rawOutput,rawTotal:rawInput+rawOutput,
    exportPriorPartsJsonBytes,toolNames};
};
const within=(base,target)=>{
  const part=relative(base,target);
  return part!==''&&part!=='..'&&!part.startsWith(`..${sep}`)
    &&!isAbsolute(part);
};
const exportPrefixBytes=messages=>{
  let prior=0;
  const turns=[];
  for(const message of messages){
    if(message.info?.role==='assistant')turns.push(prior);
    prior+=Buffer.byteLength(JSON.stringify(message.parts??[]),'utf8');
  }
  return turns;
};
const repeatedQueryTool=name=>/read|search|query|retrieve|investigate|grep|glob/iu.test(name);
const extractOutput=value=>{
  let parsed=value;
  if(typeof value==='string'){
    try{parsed=JSON.parse(value);}catch{
      const reason=/^\s*(?:Error\b|REQUESTED_SCOPE_MISSING\b|INVALID_ARGUMENT\b|TIMEOUT\b|DENIED\b|UNAVAILABLE\b)/iu.exec(value);
      return {reason:reason?.[0]??null};
    }
  }
  if(!parsed||typeof parsed!=='object')return {reason:null};
  return {reason:bounded(parsed.reason??parsed.code??parsed.error?.code),
    status:bounded(parsed.status),message:bounded(parsed.message)};
};
const responseSummary=value=>{
  let parsed=value;
  if(typeof value==='string'){
    try{parsed=JSON.parse(value);}catch{return null;}
  }
  if(!parsed||typeof parsed!=='object'
    ||(!Array.isArray(parsed.evidence)
      &&typeof parsed.truncated!=='boolean'
      &&typeof parsed.internallyTruncated!=='boolean'))return null;
  const evidence=Array.isArray(parsed.evidence)?parsed.evidence:[];
  return {truncated:parsed.truncated??null,
    internallyTruncated:parsed.internallyTruncated??null,
    wholeFilePaths:evidence.filter(item=>item?.wholeFile===true
      &&typeof item.path==='string').map(item=>item.path),
    partialFilePaths:evidence.filter(item=>item?.wholeFile===false
      &&typeof item.path==='string').map(item=>item.path)};
};
const extractTools=(messages,aligned)=>{
  let firstEditSeen=false;
  return messages.flatMap((message,index)=>(message.parts??[])
    .filter(part=>part.type==='tool'&&typeof part.tool==='string')
    .map(part=>{
      const input=part.state?.input??part.input??{};
      const output=part.state?.output;
      if(part.tool==='formal_task_replace_text')firstEditSeen=true;
      const beforeFirstEdit=!firstEditSeen;
      return {tool:part.tool,turnIndex:aligned?index+1:null,
        beforeFirstEdit,status:bounded(part.state?.status),
        input:{scope:bounded(input.scope),
          query:bounded(input.query??input.pattern??input.search),
          path:bounded(input.path??input.filePath??input.file_path),
          view:bounded(input.view),
          maxBytes:Number.isSafeInteger(input.maxBytes)&&input.maxBytes>0
            ?input.maxBytes:null},
        inputSha256:sha(JSON.stringify(input)),
        outputBytes:toolOutputBytes(output),output:extractOutput(output),
        errorBytes:toolOutputBytes(part.state?.error),
        error:extractOutput(part.state?.error),response:responseSummary(output)};
    }));
};

export const diagnoseEvaluation=async({runDir,reportDir})=>{
  const root=resolve(runDir);
  const output=reportDir?resolve(reportDir):root;
  const preflightBytes=await readFile(resolve(root,'preflight.json'));
  const postflightBytes=await readFile(resolve(root,'postflight.json'));
  const preflight=JSON.parse(preflightBytes.toString('utf8'));
  const postflight=JSON.parse(postflightBytes.toString('utf8'));
  if(preflight.runId!==postflight.runId)throw fail('DIAGNOSTIC_RUN_ID_DRIFT');
  let allowedTools=null;
  if(preflight.manifestPath){
    const manifestBytes=await readFile(preflight.manifestPath);
    if(preflight.manifestSha256&&sha(manifestBytes)!==preflight.manifestSha256)
      throw fail('DIAGNOSTIC_MANIFEST_DRIFT');
    allowedTools=JSON.parse(manifestBytes.toString('utf8')).allowedTools;
  }
  const issues=[...(postflight.issues??[])].map(code=>({code}));
  const arms=[];
  for(const arm of preflight.arms){
    const receiptPath=resolve(root,'journal',`${arm.attemptId}.settled.json`);
    let receipt=null;let tools=[];let turns=[];let transportRequests=[];
    let transportEvents=[];let transportEvidenceStatus='none';
    try{receipt=await readJson(receiptPath);}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    if(receipt){
      try{
        const exported=await readJson(resolve(arm.armRoot,'evidence/export.json'));
        const exportedMessages=Array.isArray(exported.messages)
          ?exported.messages:[];
        const priorBytes=exportPrefixBytes(exportedMessages);
        const messages=exportedMessages
          .filter(message=>message.info?.role==='assistant');
        const usage=Array.isArray(receipt.rawUsage)?receipt.rawUsage:[];
        const validUsage=usage.every(row=>[row.input,row.cacheRead,
          row.cacheWrite,row.output,row.reasoning].every(value=>
          Number.isSafeInteger(value)&&value>=0));
        const aligned=validUsage&&usage.length===messages.length
          &&usage.length===receipt.modelInvocationCount;
        if(!aligned)issues.push({code:'TURN_ALIGNMENT_MISMATCH',
          attemptId:arm.attemptId,usageTurns:usage.length,
          exportTurns:messages.length});
        tools=extractTools(messages,aligned);
        if(validUsage)turns=usage.map((row,index)=>usageTurn(row,index,
          tools.filter(event=>event.turnIndex===index+1)
            .map(event=>event.tool),aligned?priorBytes[index]:null));
      }
      catch(error){issues.push({code:'EXPORT_UNREADABLE',attemptId:arm.attemptId,
        detail:error?.code??'INVALID_JSON'});}
      if(receipt.qualityPass!==true)issues.push({code:'QUALITY_FAILED',
        attemptId:arm.attemptId,publicCheck:receipt.publicCheck,
        hiddenCheck:receipt.hiddenCheck});
      if(receipt.accountingStatus!=='complete')issues.push({code:'ACCOUNTING_UNKNOWN',
        attemptId:arm.attemptId});
      const invalidTools=Array.isArray(receipt.toolNames)
        &&Array.isArray(allowedTools?.[arm.arm])
        ?receipt.toolNames.filter(name=>!allowedTools[arm.arm].includes(name)):[];
      if(invalidTools.length>0)issues.push({code:'TOOL_BOUNDARY',
        attemptId:arm.attemptId,tools:invalidTools});
      const seen=new Map();
      for(const event of tools){
        if(event.status==='error'||event.error.reason)issues.push({
          code:'TOOL_ERROR',attemptId:arm.attemptId,tool:event.tool,
          reason:event.error.reason??event.output.reason??'TOOL_STATUS_ERROR',
          input:event.input});
        if(repeatedQueryTool(event.tool)){
          const key=JSON.stringify([event.tool,event.inputSha256]);
          const previous=seen.get(key);
          seen.set(key,{count:(previous?.count??0)+1,event});
        }
        if(event.output.reason
          &&/MISSING|INVALID|ERROR|FAIL|TIMEOUT|DENIED|UNAVAILABLE/iu
            .test(event.output.reason))issues.push({code:'TOOL_REASON',
          attemptId:arm.attemptId,tool:event.tool,reason:event.output.reason,
          input:event.input});
      }
      for(const {count,event} of seen.values()){
        if(count>1)issues.push({code:'REPEATED_TOOL_INPUT',
          attemptId:arm.attemptId,count,tool:event.tool,input:event.input});
      }
    }
    try{
      const transportBytes=await readFile(resolve(arm.armRoot,
        'evidence/transport.json'));
      const transport=JSON.parse(transportBytes.toString('utf8'));
      if(transport.schemaVersion!==1||!Array.isArray(transport.records)
        ||(receipt?.transportObservation
          &&(sha(transportBytes)!==receipt.evidenceSha256?.transport
            ||transport.records.length!==receipt.transportObservation.requestCount)))
        throw fail('TRANSPORT_EVIDENCE_DRIFT');
      transportEvidenceStatus=receipt?.transportObservation?'audited':'unaudited';
      transportEvents=(transport.events??[]).filter(event=>
        transportEventTypes.has(event?.type)&&safeTimestamp(event.at))
        .map(event=>({type:event.type,at:event.at}));
      const aligned=receipt&&transport.records.length===receipt.modelInvocationCount
        &&transport.records.length===turns.length;
      if(receipt&&!aligned)issues.push({
        code:'TRANSPORT_TURN_ALIGNMENT_MISMATCH',attemptId:arm.attemptId,
        requests:transport.records.length,usageTurns:turns.length});
      transportRequests=transport.records.map((row,index)=>({
        index:row.index,requestBytes:row.requestBytes,
        requestSha256:row.requestSha256,
        responseStatus:row.responseStatus,responseBytes:row.responseBytes,
        providerInputTokens:row.usage?.prompt_tokens
          ??row.usage?.input_tokens??null,
        providerOutputTokens:row.usage?.completion_tokens
          ??row.usage?.output_tokens??null,
        cacheReadTokens:row.usage?.prompt_tokens_details?.cached_tokens
          ??row.usage?.input_tokens_details?.cache_read_tokens??null,
        rawInput:aligned?turns[index].rawInput:null,
        rawOutput:aligned?turns[index].rawOutput:null,
        errorCode:transportErrorCodes.has(row.errorCode)?row.errorCode:null,
        ...(safeTimestamp(row.startedAt)
          ?{startedAt:row.startedAt}:{}),
        ...(safeDuration(row.durationMs)!=null
          ?{durationMs:row.durationMs}:{}),
        ...(safeDuration(row.responseHeaderMs)!=null
          ?{responseHeaderMs:row.responseHeaderMs}:{}),
        ...(requestEvents.has(row.terminalEvent)
          ?{terminalEvent:row.terminalEvent}:{}),
        ...(['downstream','observer'].includes(row.cancelSource)
          ?{cancelSource:row.cancelSource}:{}),
        ...(errorClasses.has(row.errorClass)
          ?{errorClass:row.errorClass}:{}),
        ...(row.sseErrorCode==='UPSTREAM_SSE_ERROR'
          ?{sseErrorCode:row.sseErrorCode}:{}),
        requestShape:safeRequestShape(row.requestShape)}));
      for(const row of transportRequests){
        if(row.sseErrorCode==='UPSTREAM_SSE_ERROR'
          ||row.terminalEvent==='UPSTREAM_SSE_ERROR')issues.push({
          code:'UPSTREAM_SSE_ERROR',attemptId:arm.attemptId,index:row.index});
        if(row.responseStatus>=400)issues.push({code:'UPSTREAM_HTTP_ERROR',
          attemptId:arm.attemptId,index:row.index,status:row.responseStatus});
        if(['UPSTREAM_CONNECTION_ERROR','UPSTREAM_STREAM_ERROR',
          'DOWNSTREAM_CANCEL','OBSERVER_CANCEL','OBSERVER_ERROR']
          .includes(row.terminalEvent))
          issues.push({code:row.terminalEvent,attemptId:arm.attemptId,
            index:row.index,errorClass:row.errorClass??null});
        else if(row.errorCode==='UPSTREAM_TRANSPORT_FAILED')issues.push({
          code:'UPSTREAM_TRANSPORT_FAILED',attemptId:arm.attemptId,index:row.index});
      }
      const usageIndexes=transport.records.filter(row=>row.usage!=null)
        .map(row=>row.index);
      if(receipt&&usageIndexes.length>turns.length)issues.push({
        code:'TRANSPORT_USAGE_REQUEST_OVERAGE',attemptId:arm.attemptId,
        requests:transport.records.length,usageRequests:usageIndexes.length,
        usageTurns:turns.length,indexes:usageIndexes});
      else if(receipt&&turns.length===receipt.modelInvocationCount
        &&transport.records.length>turns.length
        &&usageIndexes.length===turns.length)issues.push({
        code:'TRANSPORT_REQUEST_OVERAGE_NO_USAGE',attemptId:arm.attemptId,
        requests:transport.records.length,usageRequests:usageIndexes.length,
        usageTurns:turns.length,
        indexes:transport.records.filter(row=>row.usage==null)
          .map(row=>row.index)});
      if(receipt&&turns.length>0
        &&turns.length===receipt.modelInvocationCount
        &&transportRequests.length>turns.length){
        const numeric=numericTurnCandidates(turns,transportRequests);
        if(numeric)issues.push({code:'TRANSPORT_NUMERIC_TURN_CANDIDATES',
          attemptId:arm.attemptId,...numeric});
      }
      if(transportEvents.some(event=>event.type==='ARM_TIMEOUT'))issues.push({
        code:'ARM_TIMEOUT',attemptId:arm.attemptId});
    }catch(error){
      if(error?.code!=='ENOENT'||receipt?.transportObservation)issues.push({
        code:'TRANSPORT_EVIDENCE_DRIFT',attemptId:arm.attemptId,
        detail:error?.code??'INVALID_JSON'});
    }
    if(!receipt&&!transportEvents.some(event=>event.type==='ARM_TIMEOUT')){
      try{
        const outcome=await readJson(resolve(arm.armRoot,
          'evidence/run-outcome.json'));
        if(outcome.timedOut===true)issues.push({code:'ARM_TIMEOUT',
          attemptId:arm.attemptId});
      }catch(error){
        if(error?.code!=='ENOENT')issues.push({code:'RUN_OUTCOME_UNREADABLE',
          attemptId:arm.attemptId});
      }
    }
    arms.push({attemptId:arm.attemptId,pairId:arm.pairId,arm:arm.arm,
      settled:receipt!==null,rawTotal:receipt?.normalizedUsage?.rawTotal??null,
      modelCalls:receipt?.modelInvocationCount??null,
      firstInputTokens:receipt?.rawUsage?.[0]?.input??null,
      costUsd:receipt?.costUsd??null,qualityPass:receipt?.qualityPass??null,
      toolCalls:tools.length,
      preEditPublicTests:tools.filter(event=>event.beforeFirstEdit
        &&event.tool==='formal_task_run_public_test').length,
      invalidTools:receipt&&Array.isArray(receipt.toolNames)
        &&Array.isArray(allowedTools?.[arm.arm])
        ?receipt.toolNames.filter(name=>!allowedTools[arm.arm].includes(name)):[],
      toolOutputBytes:tools.reduce((sum,event)=>sum+event.outputBytes,0),
      toolErrorBytes:tools.reduce((sum,event)=>sum+event.errorBytes,0),
      wholeFileEvidence:tools.reduce((sum,event)=>
        sum+(event.response?.wholeFilePaths.length??0),0),
      partialEvidence:tools.reduce((sum,event)=>
        sum+(event.response?.partialFilePaths.length??0),0),
      turns,tools,transportRequests,transportEvents,transportEvidenceStatus});
  }
  const pairs=(postflight.pairRows??[]).map(row=>{
    const a=arms.find(arm=>arm.pairId===row.pairId&&arm.arm==='A');
    const c=arms.find(arm=>arm.pairId===row.pairId&&arm.arm==='C');
    const modelCallDelta=a?.modelCalls!=null&&c?.modelCalls!=null
      ?c.modelCalls-a.modelCalls:null;
    const toolOutputByteDelta=a?.settled&&c?.settled
      ?c.toolOutputBytes-a.toolOutputBytes:null;
    if(row.complete&&row.tokenPass===false)issues.push({code:'PAIR_TOKEN_REGRESSION',
      pairId:row.pairId,aRawTotal:row.aRawTotal,cRawTotal:row.cRawTotal,
      delta:row.cRawTotal-row.aRawTotal});
    if(row.complete&&modelCallDelta!==null&&modelCallDelta>0)
      issues.push({code:'C_MORE_MODEL_CALLS',pairId:row.pairId,
        aModelCalls:a.modelCalls,cModelCalls:c.modelCalls,modelCallDelta});
    return {...row,delta:row.complete?row.cRawTotal-row.aRawTotal:null,
      aModelCalls:a?.modelCalls??null,cModelCalls:c?.modelCalls??null,
      modelCallDelta,toolOutputByteDelta};
  });
  const report={schemaVersion:1,state:'DIAGNOSED',runId:preflight.runId,
    sourceSha256:{preflight:sha(preflightBytes),postflight:sha(postflightBytes)},
    schedulerState:postflight.schedulerState,
    plannedPairs:postflight.plannedPairs,completePairs:postflight.completePairs,
    modelCalls:postflight.modelCalls,knownCostUsd:postflight.knownCostUsd,
    pairs,arms,issues};
  if(reportDir){
    const temp=await realpath(resolve(import.meta.dirname,'../..','.tmp'));
    const parent=await realpath(dirname(output));
    if(!within(temp,output)||!(parent===temp||within(temp,parent)))
      throw fail('DIAGNOSTIC_OUTPUT_OUTSIDE_TEMP');
    await mkdir(output);
  }
  await writeFile(resolve(output,'diagnostics.json'),
    `${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',flag:'wx'});
  const lines=[`# A/B 诊断：${report.runId}`,'',
    `- 调度状态：${report.schedulerState}`,
    `- 完成对数：${report.completePairs}/${report.plannedPairs}`,
    `- 模型调用：${report.modelCalls}`,
    `- 已知费用（美元）：${report.knownCostUsd}`,
    `- 诊断项：${issues.length}`,'',
    '| Pair | A rawTotal | C rawTotal | C-A | A/C 调用 | C-A 调用 | C-A 工具字节 | 质量 | Token |',
    '| --- | ---: | ---: | ---: | --- | ---: | ---: | --- | --- |',
    ...pairs.map(pair=>`| ${pair.pairId} | ${pair.aRawTotal??'—'} | `
      +`${pair.cRawTotal??'—'} | ${pair.delta??'—'} | `
      +`${pair.aModelCalls??'—'}/${pair.cModelCalls??'—'} | `
      +`${pair.modelCallDelta??'—'} | ${pair.toolOutputByteDelta??'—'} | `
      +`${!pair.complete?'未运行':pair.qualityPass?'通过':'未通过'} | `
      +`${!pair.complete?'未运行':pair.tokenPass?'通过':'未通过'} |`),
    '', '| 臂 | 模型调用 | 首轮输入 token | 工具调用 | 工具输出字节 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...arms.filter(arm=>arm.settled).map(arm=>`| ${arm.attemptId} | `
      +`${arm.modelCalls} | ${arm.firstInputTokens??'—'} | `
      +`${arm.toolCalls} | ${arm.toolOutputBytes} |`),
    '', '## 逐回合账目', '',
    '| 臂 | 回合 | input | cacheRead | cacheWrite | output | reasoning | rawInput | rawOutput | rawTotal | 导出历史字节 | 工具 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...arms.flatMap(arm=>arm.turns.map(turn=>`| ${arm.attemptId} | `
      +`${turn.index} | ${turn.input} | ${turn.cacheRead} | `
      +`${turn.cacheWrite} | ${turn.output} | ${turn.reasoning} | `
      +`${turn.rawInput} | ${turn.rawOutput} | `
      +`${turn.rawTotal} | ${turn.exportPriorPartsJsonBytes??'—'} | `
      +`${turn.toolNames.join(', ')||'—'} |`)),
    '', '## 传输请求与用量', '',
    '| 臂 | 请求 | 请求字节 | 消息数 | 消息字节 | 工具数 | 工具字节 | 其他字节 | rawInput | 提供方输入 | rawOutput | 提供方输出 | 缓存读取 | 响应字节 | HTTP | 请求摘要 | 开始时间 | 耗时毫秒 | 事件 | 取消来源 | 错误类别 | 流内错误 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- |',
    ...arms.flatMap(arm=>arm.transportRequests.map(row=>`| ${arm.attemptId} | `
      +`${row.index} | ${row.requestBytes} | `
      +`${row.requestShape?.messageCount??'—'} | `
      +`${row.requestShape?.messageBytes??'—'} | `
      +`${row.requestShape?.toolCount??'—'} | `
      +`${row.requestShape?.toolBytes??'—'} | `
      +`${row.requestShape?.otherBytes??'—'} | ${row.rawInput} | `
      +`${row.providerInputTokens??'—'} | ${row.rawOutput} | `
      +`${row.providerOutputTokens??'—'} | ${row.cacheReadTokens??'—'} | `
      +`${row.responseBytes} | ${row.responseStatus??'—'} | `
      +`${row.requestSha256??'—'} | ${row.startedAt??'—'} | `
      +`${row.durationMs??'—'} | ${row.terminalEvent??'—'} | `
      +`${row.cancelSource??'—'} | ${row.errorClass??'—'} | ${row.sseErrorCode??'—'} |`)),
    '', '## 观察器与臂事件', '',
    ...arms.flatMap(arm=>arm.transportEvents.map(event=>
      `- ${arm.attemptId} ${event.type} ${event.at}`)),
    '', ...arms.filter(arm=>arm.settled).map(arm=>`- ${arm.attemptId} `
      +`修改前公开测试：${arm.preEditPublicTests}；工具错误字节：`
      +`${arm.toolErrorBytes}；截断响应：${arm.tools.filter(event=>
        event.response?.truncated===true).length}；完整文件证据：`
      +`${arm.wholeFileEvidence}；片段证据：${arm.partialEvidence}。`),
    '',...issues.map(issue=>`- ${issue.code}: ${issue.attemptId??issue.pairId??''}`
      +`${issue.tool?` ${issue.tool}`:''}${issue.count?` ×${issue.count}`:''}`
      +`${issue.tools?.length?` ${issue.tools.join(',')}`:''}`
      +`${issue.reason?` ${issue.reason}`:''}`
      +`${issue.input?.query?` query=${issue.input.query}`:''}`
      +`${issue.input?.path?` path=${issue.input.path}`:''}`
      +`${issue.delta!==undefined?` C-A=${issue.delta}`:''}`
      +`${issue.index!==undefined?` 请求=${issue.index}`:''}`
      +`${issue.status!==undefined?` HTTP=${issue.status}`:''}`
      +`${issue.modelCallDelta!==undefined?` C-A调用=${issue.modelCallDelta}`:''}`),
    ''];
  await writeFile(resolve(output,'diagnostics.md'),lines.join('\n'),
    {encoding:'utf8',flag:'wx'});
  return report;
};
