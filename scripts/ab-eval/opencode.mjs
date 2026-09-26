import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { stripVTControlCharacters } from 'node:util';

import { startTransportObserver } from './transport-observer.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const fail=code=>Object.assign(new Error(code),{code});
const inside=(base,path)=>path===base||path.startsWith(base+sep);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const secretName=/OPENAI|ANTHROPIC|GEMINI|GOOGLE.*AI|DEEPSEEK|XAI|GROQ|MISTRAL|COHERE|API[_-]?KEY|ACCESS[_-]?TOKEN/iu;

export const buildOpenCodeInvocation=({executable,profile,armRoot,fixtureRoot,
  configPath,prompt,attemptId})=>{
  if(![executable,profile?.model,profile?.variant,profile?.agent,prompt,attemptId]
    .every(x=>typeof x==='string'&&x.length>0)||!inside(resolve(armRoot),resolve(fixtureRoot))
    ||!inside(resolve(armRoot),resolve(configPath)))throw fail('OPENCODE_INVOCATION_INVALID');
  const env=Object.fromEntries(Object.entries(process.env)
    .filter(([key])=>!secretName.test(key)
      &&!/^CODEX_/iu.test(key)&&!/^OPENCODE_/iu.test(key)));
  Object.assign(env,{
    HOME:resolve(armRoot,'home'),USERPROFILE:resolve(armRoot,'userprofile'),
    APPDATA:resolve(armRoot,'appdata'),LOCALAPPDATA:resolve(armRoot,'localappdata'),
    OPENCODE_CONFIG:resolve(configPath),
    OPENCODE_CONFIG_DIR:resolve(armRoot,'config-dir'),
    XDG_CONFIG_HOME:resolve(armRoot,'xdg-config'),
    XDG_STATE_HOME:resolve(armRoot,'xdg-state'),
    XDG_CACHE_HOME:resolve(armRoot,'xdg-cache'),
    XDG_DATA_HOME:resolve(armRoot,'xdg-data'),
    OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',
    OPENCODE_DISABLE_PRUNE:'1',OPENCODE_DISABLE_TERMINAL_TITLE:'1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS:'1',OPENCODE_DISABLE_LSP_DOWNLOAD:'1',
    OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_AUTOCOMPACT:'1',
  });
  return {executable,args:['run','--pure','--model',profile.model,
    '--variant',profile.variant,'--agent',profile.agent,'--format','json',
    '--no-replay','--dir',resolve(fixtureRoot),'--title',`ab-${attemptId}`,prompt],
  cwd:resolve(fixtureRoot),env};
};

export const probeOpenCodeClient=async({executable,tempRoot,
  processRunner=spawnBounded})=>{
  await mkdir(tempRoot,{recursive:true});
  const armRoot=await mkdtemp(resolve(tempRoot,'ab-eval-client-doctor-'));
  try{
    const fixtureRoot=resolve(armRoot,'work');
    await mkdir(fixtureRoot);
    const configPath=resolve(armRoot,'opencode.json');
    await writeFile(configPath,`${JSON.stringify({mcp:{ab_probe:{type:'local',
      command:[process.execPath,resolve(import.meta.dirname,'smoke-mcp.mjs')],
      enabled:true,timeout:30000}}},null,2)}\n`,{flag:'wx'});
    const spec=buildOpenCodeInvocation({executable,
      profile:{model:'probe/model',variant:'high',agent:'build'},armRoot,
      fixtureRoot,configPath,prompt:'model-disabled-check',attemptId:'doctor'});
    const version=await processRunner({executable,args:['--version'],
      cwd:fixtureRoot,env:spec.env,timeoutMs:30000});
    if(version.status!==0||version.timedOut||version.errorCode)
      throw fail('OPENCODE_VERSION_PROBE_FAILED');
    const check=await processRunner({executable,args:['mcp','list'],
      cwd:fixtureRoot,env:spec.env,timeoutMs:30000});
    const output=stripVTControlCharacters(`${check.stdout??''}\n${check.stderr??''}`);
    if(check.status!==0||check.timedOut||check.errorCode
      ||!output.split(/\r?\n/u).some(line=>line.includes('ab_probe')
        &&/\bconnected\b/iu.test(line)))
      throw fail('OPENCODE_MCP_PROBE_FAILED');
    return {state:'CLIENT_CONNECTED',version:version.stdout.trim(),modelCalls:0};
  }finally{await rm(armRoot,{recursive:true,force:true});}
};

const terminateOwned=child=>{
  if(child.pid===undefined)return;
  if(process.platform==='win32'){
    spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],
      {windowsHide:true,shell:false,timeout:5000,stdio:'ignore'});
  }else{
    try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
  }
};

export const spawnBounded=({executable,args,cwd,env,timeoutMs=600000,
  maxOutputBytes=16*1024*1024})=>new Promise(resolveResult=>{
  const child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,
    detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  const stdout=[];const stderr=[];
  let outputBytes=0;let timedOut=false;let outputTruncated=false;let errorCode=null;
  const capture=(target,chunk)=>{
    outputBytes+=chunk.length;
    if(outputBytes>maxOutputBytes){
      if(!outputTruncated){outputTruncated=true;terminateOwned(child);}
      return;
    }
    target.push(chunk);
  };
  child.stdout.on('data',chunk=>capture(stdout,chunk));
  child.stderr.on('data',chunk=>capture(stderr,chunk));
  child.on('error',error=>{errorCode=error.code??'SPAWN_FAILED';});
  const timer=setTimeout(()=>{timedOut=true;terminateOwned(child);},timeoutMs);
  child.on('close',(status,signal)=>{
    clearTimeout(timer);
    resolveResult({status,signal,stdout:Buffer.concat(stdout).toString('utf8'),
      stderr:Buffer.concat(stderr).toString('utf8'),timedOut,outputTruncated,errorCode});
  });
});

const prepareAuth=async({sourcePath,armRoot})=>{
  const source=await readFile(sourcePath);
  const sourceSha256=sha(source);
  const target=resolve(armRoot,'xdg-data','opencode','auth.json');
  await mkdir(resolve(armRoot,'xdg-data','opencode'),{recursive:true});
  let handle;
  try{
    handle=await open(target,'wx',0o600);
    await handle.writeFile(source);
    await handle.close();handle=null;
    if(sha(await readFile(target))!==sourceSha256
      ||sha(await readFile(sourcePath))!==sourceSha256)
      throw fail('OPENCODE_AUTH_SOURCE_DRIFT');
    return {target,sourceSha256};
  }catch(error){
    await handle?.close().catch(()=>{});
    await rm(target,{force:true});
    throw error;
  }
};

const parseTrace=text=>{
  const events=text.split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line));
  const ids=[...new Set(events.map(x=>x.sessionID).filter(x=>typeof x==='string'))];
  if(ids.length!==1)throw fail('OPENCODE_TRACE_SESSION_INVALID');
  const steps=events.filter(x=>x.type==='step_finish');
  if(steps.length===0)throw fail('OPENCODE_TRACE_USAGE_MISSING');
  return {sessionId:ids[0],steps};
};

const usageFrom=info=>{
  const tokens=info?.tokens;
  const values=[tokens?.input,tokens?.output,tokens?.reasoning,
    tokens?.cache?.read,tokens?.cache?.write];
  if(!values.every(integer)||!Number.isFinite(info?.cost)||info.cost<0)
    throw fail('OPENCODE_USAGE_INCOMPLETE');
  return {input:tokens.input,output:tokens.output,reasoning:tokens.reasoning,
    cacheRead:tokens.cache.read,cacheWrite:tokens.cache.write,costUsd:info.cost};
};
const usageTotal=rows=>({
  rawInput:rows.reduce((n,x)=>n+x.input+x.cacheRead+x.cacheWrite,0),
  rawOutput:rows.reduce((n,x)=>n+x.output+x.reasoning,0),
});

const parseExport=(text,{sessionId,profile})=>{
  const value=JSON.parse(text);
  const info=value.info??value.session??value.sessionInfo;
  if(info?.id!==sessionId||info.version!==profile.version)
    throw fail('OPENCODE_EXPORT_IDENTITY_DRIFT');
  const messages=(value.messages??[]).filter(x=>x.info?.role==='assistant');
  const last=messages.at(-1)?.info;
  const slash=profile.model.indexOf('/');
  if(slash<1||(info.model?.providerID??last?.providerID)!==profile.model.slice(0,slash)
    ||(info.model?.id??last?.modelID)!==profile.model.slice(slash+1)
    ||(info.model?.variant??last?.variant)!==profile.variant)
    throw fail('OPENCODE_MODEL_IDENTITY_DRIFT');
  if(messages.length===0)throw fail('OPENCODE_EXPORT_USAGE_MISSING');
  const usages=messages.map(x=>usageFrom(x.info));
  const toolNames=[...new Set(messages.flatMap(x=>(x.parts??[])
    .filter(part=>part.type==='tool'&&typeof part.tool==='string')
    .map(part=>part.tool)))];
  const total=usageTotal(usages);
  return {usages,toolNames,normalizedUsage:{...total,rawTotal:total.rawInput+total.rawOutput},
    costUsd:usages.reduce((n,x)=>n+x.costUsd,0),modelInvocationCount:messages.length};
};

const prepareTransportObservation=async({configPath,evidenceRoot,profile})=>{
  if(!evidenceRoot)throw fail('TRANSPORT_EVIDENCE_ROOT_REQUIRED');
  const originalBytes=await readFile(configPath);
  const original=JSON.parse(originalBytes.toString('utf8'));
  const providerID=profile.model.slice(0,profile.model.indexOf('/'));
  const provider=original.provider?.[providerID];
  const upstreamBaseURL=provider?.options?.baseURL;
  if(typeof upstreamBaseURL!=='string')
    throw fail('TRANSPORT_UPSTREAM_MISSING');
  const observer=await startTransportObserver({upstreamBaseURL});
  try{
    const observed=globalThis.structuredClone(original);
    observed.provider[providerID].options.baseURL=observer.baseURL;
    const observedBytes=`${JSON.stringify(observed,null,2)}\n`;
    await mkdir(evidenceRoot,{recursive:true});
    const observedConfigPath=resolve(evidenceRoot,'transport-config.json');
    await writeFile(observedConfigPath,observedBytes,{flag:'wx'});
    return {observer,observedConfigPath,
      configSha256:sha(observedBytes),originalConfigSha256:sha(originalBytes)};
  }catch(error){await observer.close();throw error;}
};

export const runOpenCodeArm=async({executable,profile,armRoot,fixtureRoot,configPath,
  authPath,prompt,attemptId,timeoutMs=600000,processRunner=spawnBounded,evidenceRoot,
  transportObservation=false})=>{
  const observation=transportObservation?await prepareTransportObservation({
    configPath,evidenceRoot,profile}):null;
  let observationResult=null;
  const finishObservation=async()=>{
    if(!observation)return null;
    if(observationResult)return observationResult;
    const records=await observation.observer.close();
    const bytes=`${JSON.stringify({schemaVersion:1,
      events:observation.observer.events,records},null,2)}\n`;
    await writeFile(resolve(evidenceRoot,'transport.json'),bytes,{flag:'wx'});
    observationResult={requestCount:records.length,
      configSha256:observation.configSha256,
      originalConfigSha256:observation.originalConfigSha256,
      evidenceSha256:sha(bytes)};
    return observationResult;
  };
  let auth;
  try{
    const spec=buildOpenCodeInvocation({executable,profile,armRoot,fixtureRoot,
      configPath:observation?.observedConfigPath??configPath,prompt,attemptId});
    if(observation){
      const providerID=profile.model.slice(0,profile.model.indexOf('/'));
      const expected=JSON.parse(await readFile(observation.observedConfigPath,'utf8'))
        .provider[providerID].options.baseURL;
      spec.env.OPENCODE_CONFIG_CONTENT=JSON.stringify({provider:{[providerID]:{
        options:{baseURL:expected}}}});
      const check=await processRunner({executable,args:['debug','config','--pure'],
        cwd:spec.cwd,env:spec.env,timeoutMs:30000});
      if(check.status!==0||check.timedOut||check.outputTruncated||check.errorCode)
        throw fail('TRANSPORT_CONFIG_PROBE_FAILED');
      let effective;
      try{effective=JSON.parse(stripVTControlCharacters(check.stdout));}
      catch{throw fail('TRANSPORT_CONFIG_PROBE_FAILED');}
      const effectiveBase=effective.provider?.[providerID]?.options?.baseURL;
      const safeBase=value=>{
        try{const url=new URL(value);return `${url.origin}${url.pathname}`;}
        catch{return null;}
      };
      await writeFile(resolve(evidenceRoot,'transport-config-probe.json'),
        `${JSON.stringify({providerID,expectedBaseURL:expected,
          effectiveBaseURL:safeBase(effectiveBase)},null,2)}\n`,{flag:'wx'});
      if(effectiveBase!==expected)
        throw fail('TRANSPORT_CONFIG_NOT_EFFECTIVE');
    }
    auth=await prepareAuth({sourcePath:authPath,armRoot});
    const run=await processRunner({...spec,timeoutMs});
    if(run.timedOut)observation?.observer.recordArmTimeout();
    const observed=await finishObservation();
    if(evidenceRoot){
      await mkdir(evidenceRoot,{recursive:true});
      await writeFile(resolve(evidenceRoot,'run.jsonl'),run.stdout??'',{flag:'wx'});
    }
    if(run.status!==0||run.timedOut||run.outputTruncated||run.errorCode){
      if(evidenceRoot)await writeFile(resolve(evidenceRoot,'run-outcome.json'),
        `${JSON.stringify({schemaVersion:1,status:run.status??null,
          signal:run.signal??null,timedOut:run.timedOut===true,
          outputTruncated:run.outputTruncated===true,errorCode:run.errorCode??null,
          stdoutBytes:Buffer.byteLength(run.stdout??''),
          stderrBytes:Buffer.byteLength(run.stderr??'')},null,2)}\n`,{flag:'wx'});
      throw fail(run.errorCode?'OPENCODE_SPAWN_FAILED':'OPENCODE_RUN_FAILED');
    }
    const trace=parseTrace(run.stdout);
    const exported=await processRunner({executable,args:['export','--pure',trace.sessionId],
      cwd:spec.cwd,env:spec.env,timeoutMs:30000});
    if(evidenceRoot)await writeFile(resolve(evidenceRoot,'export.json'),
      exported.stdout??'',{flag:'wx'});
    if(exported.status!==0||exported.timedOut||exported.outputTruncated||exported.errorCode)
      throw fail('OPENCODE_EXPORT_FAILED');
    const parsed=parseExport(exported.stdout,{sessionId:trace.sessionId,profile});
    const traceUsages=trace.steps.map(x=>usageFrom({tokens:x.part?.tokens,cost:x.part?.cost}));
    const traceTotal=usageTotal(traceUsages);
    if(traceUsages.length!==parsed.usages.length
      ||traceTotal.rawInput!==parsed.normalizedUsage.rawInput
      ||traceTotal.rawOutput!==parsed.normalizedUsage.rawOutput)
      throw fail('OPENCODE_TRACE_EXPORT_DRIFT');
    if(observed&&observed.requestCount<parsed.modelInvocationCount)
      throw fail('TRANSPORT_OBSERVATION_INCOMPLETE');
    return {attemptId,success:true,accountingStatus:'complete',
      sideEffectStatus:'KNOWN_COMPLETED',modelInvocationCount:parsed.modelInvocationCount,
      normalizedUsage:parsed.normalizedUsage,costUsd:parsed.costUsd,
      toolNames:parsed.toolNames,rawUsage:parsed.usages,
      evidenceSha256:{run:sha(run.stdout),export:sha(exported.stdout),
        ...(observed?{transport:observed.evidenceSha256}:{})},
      ...(observed?{transportObservation:{requestCount:observed.requestCount,
        configSha256:observed.configSha256,
        originalConfigSha256:observed.originalConfigSha256}}:{}),
      authSourceSha256:auth.sourceSha256,
      sessionId:trace.sessionId,clientVersion:profile.version,
      resolvedModel:profile.model,variant:profile.variant};
  }finally{
    try{await finishObservation();}
    finally{if(auth)await rm(auth.target,{force:true});}
  }
};

export const auditOpenCodeEvidence=async({receipt,evidenceRoot,profile,configPath,
  requireTransportObservation=false})=>{
  const issues=[];
  try{
    const [run,exported]=await Promise.all([
      readFile(resolve(evidenceRoot,'run.jsonl'),'utf8'),
      readFile(resolve(evidenceRoot,'export.json'),'utf8'),
    ]);
    if(sha(run)!==receipt.evidenceSha256?.run
      ||sha(exported)!==receipt.evidenceSha256?.export)
      issues.push('EVIDENCE_DRIFT');
    const trace=parseTrace(run);
    const parsed=parseExport(exported,{sessionId:trace.sessionId,profile});
    const traceUsages=trace.steps.map(x=>usageFrom({tokens:x.part?.tokens,cost:x.part?.cost}));
    const total=usageTotal(traceUsages);
    if(traceUsages.length!==parsed.usages.length
      ||total.rawInput!==parsed.normalizedUsage.rawInput
      ||total.rawOutput!==parsed.normalizedUsage.rawOutput
      ||JSON.stringify(parsed.usages)!==JSON.stringify(receipt.rawUsage)
      ||JSON.stringify(parsed.normalizedUsage)!==JSON.stringify(receipt.normalizedUsage)
      ||parsed.modelInvocationCount!==receipt.modelInvocationCount
      ||parsed.costUsd!==receipt.costUsd
      ||JSON.stringify(parsed.toolNames)!==JSON.stringify(receipt.toolNames))
      issues.push('RECEIPT_ACCOUNTING_DRIFT');
    if(requireTransportObservation&&!receipt.transportObservation)
      issues.push('TRANSPORT_EVIDENCE_MISSING');
    if(receipt.transportObservation){
      try{
        if(!configPath)throw fail('TRANSPORT_CONFIG_PATH_MISSING');
        const [originalBytes,configBytes,transportBytes]=await Promise.all([
          readFile(configPath),
          readFile(resolve(evidenceRoot,'transport-config.json')),
          readFile(resolve(evidenceRoot,'transport.json')),
        ]);
        const original=JSON.parse(originalBytes.toString('utf8'));
        const observed=JSON.parse(configBytes.toString('utf8'));
        const transport=JSON.parse(transportBytes.toString('utf8'));
        const providerID=profile.model.slice(0,profile.model.indexOf('/'));
        const observedBase=observed.provider?.[providerID]?.options?.baseURL;
        const loopback=new URL(observedBase);
        observed.provider[providerID].options.baseURL=
          original.provider?.[providerID]?.options?.baseURL;
        if(sha(originalBytes)!==receipt.transportObservation.originalConfigSha256
          ||sha(configBytes)!==receipt.transportObservation.configSha256
          ||sha(transportBytes)!==receipt.evidenceSha256?.transport
          ||loopback.protocol!=='http:'||loopback.hostname!=='127.0.0.1'
          ||JSON.stringify(observed)!==JSON.stringify(original)
          ||transport.schemaVersion!==1
          ||!Array.isArray(transport.records)
          ||transport.records.length!==receipt.transportObservation.requestCount)
          issues.push('TRANSPORT_EVIDENCE_DRIFT');
      }catch{issues.push('TRANSPORT_EVIDENCE_DRIFT');}
    }
  }catch(error){issues.push(error?.code??'EVIDENCE_READ_FAILED');}
  return {valid:issues.length===0,issues};
};
