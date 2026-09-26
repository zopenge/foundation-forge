import { createHash, randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { platform, arch } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { validatePack, resolvePackPath } from './manifest.mjs';
import { assessReplicatedAudit } from './acceptance.mjs';
import { auditOpenCodeEvidence, buildOpenCodeInvocation,
  runOpenCodeArm, spawnBounded } from './opencode.mjs';
import { runPairSchedule } from './scheduler.mjs';
import { assertToolContract, probeMcpTools } from './tool-contract.mjs';
import { validateTransportBaseURL } from './transport-observer.mjs';

const repoRoot=resolve(import.meta.dirname,'../..');
const temporaryRoot=resolve(repoRoot,'.tmp');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const fail=code=>Object.assign(new Error(code),{code});
const inside=(base,path)=>path===base||path.startsWith(base+sep);
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const writeJson=(path,value)=>writeFile(path,`${JSON.stringify(value,null,2)}\n`,
  {encoding:'utf8',flag:'wx'});
const exists=async path=>{
  try{await access(path);return true;}
  catch(error){if(error?.code==='ENOENT')return false;throw error;}
};

const render=(value,vars)=>{
  if(typeof value==='string'){
    let output=value;
    for(const [key,replacement] of Object.entries(vars))
      output=output.replaceAll(`{{${key}}}`,replacement);
    if(/\{\{[^{}]+\}\}/u.test(output))throw fail('CONFIG_PLACEHOLDER_UNKNOWN');
    return output;
  }
  if(Array.isArray(value))return value.map(item=>render(item,vars));
  if(value!==null&&typeof value==='object')return Object.fromEntries(
    Object.entries(value).map(([key,item])=>[key,render(item,vars)]));
  return value;
};

const hashTree=async root=>{
  const rows=[];
  const walk=async(dir,rel='')=>{
    for(const entry of (await readdir(dir,{withFileTypes:true}))
      .sort((a,b)=>a.name.localeCompare(b.name))){
      const path=resolve(dir,entry.name);
      const next=rel?`${rel}/${entry.name}`:entry.name;
      const info=await lstat(path);
      if(info.isSymbolicLink())throw fail('FIXTURE_SYMLINK_FORBIDDEN');
      if(info.isDirectory())await walk(path,next);
      else if(info.isFile())rows.push([next,sha(await readFile(path))]);
      else throw fail('FIXTURE_FILE_TYPE_INVALID');
    }
  };
  await walk(root);
  return sha(JSON.stringify(rows));
};

const assertRunDir=runDir=>{
  const target=resolve(runDir);
  if(!inside(temporaryRoot,target)||target===temporaryRoot)
    throw fail('RUN_DIR_OUTSIDE_REPOSITORY_TEMP');
  return target;
};

export const prepareEvaluation=async({manifestPath,runDir,clientExecutable,authPath,
  processRunner=spawnBounded})=>{
  const target=assertRunDir(runDir);
  const {manifest,base,manifestSha256}=await validatePack(manifestPath);
  const binary=resolve(clientExecutable);
  const auth=resolve(authPath);
  if(!(await lstat(binary)).isFile()||!(await lstat(auth)).isFile())
    throw fail('CLIENT_INPUT_INVALID');
  const version=await processRunner({executable:binary,args:['--version'],
    cwd:base,env:process.env,timeoutMs:30000});
  if(version.status!==0||version.stdout.trim()!==manifest.client.version)
    throw fail('OPENCODE_VERSION_DRIFT');
  const candidatePath=resolvePackPath(base,manifest.candidate);
  const clientBinarySha256=sha(await readFile(binary));
  const authSha256=sha(await readFile(auth));
  const runId=`${manifest.id}-${randomUUID()}`;
  await mkdir(dirname(target),{recursive:true});
  await mkdir(target,{recursive:false});
  const arms=[];
  for(const pair of manifest.pairs){
    const task=manifest.tasks.find(item=>item.id===pair.taskId);
    for(const arm of pair.order){
      const attemptId=`${pair.id}-${arm}`;
      const armRoot=resolve(target,'arms',attemptId);
      const workDir=resolve(armRoot,'work');
      await mkdir(armRoot,{recursive:true});
      await cp(resolvePackPath(base,task.fixture),workDir,{recursive:true});
      if(task.setup){
        const setup=await processRunner({executable:process.execPath,
          args:[resolvePackPath(base,task.setup),workDir,armRoot,candidatePath,
            arm,task.id],
          cwd:base,env:process.env,timeoutMs:120000});
        if(setup.status!==0||setup.timedOut||setup.outputTruncated||setup.errorCode)
          throw fail('TASK_SETUP_FAILED');
      }
      const configPath=resolve(armRoot,'opencode.json');
      const template=await readJson(resolvePackPath(base,manifest.configs[arm]));
      const config=render(template,{WORK_DIR:workDir,ARM_DIR:armRoot,
        PACK_DIR:base,CANDIDATE:candidatePath,NODE:process.execPath});
      const configBytes=`${JSON.stringify(config,null,2)}\n`;
      await writeFile(configPath,configBytes,{encoding:'utf8',flag:'wx'});
      arms.push({attemptId,pairId:pair.id,taskId:task.id,arm,armRoot,
        workDir,configPath,configSha256:sha(configBytes),
        fixtureSha256:await hashTree(workDir)});
    }
  }
  const preflight={schemaVersion:1,state:'MODEL_DISABLED_PREPARED',
    runId,manifestPath:resolve(manifestPath),manifestSha256,
    candidateSha256:manifest.files[manifest.candidate],
    clientExecutable:binary,clientBinarySha256,authPath:auth,
    authSha256,clientVersion:manifest.client.version,
    environment:{platform:platform(),arch:arch(),node:process.version},
    arms,modelCalls:0,preparedAtUtc:new Date().toISOString()};
  await writeJson(resolve(target,'preflight.json'),preflight);
  await writeJson(resolve(target,'approval-template.json'),{approved:false,
    runId,manifestSha256,approvedArmIds:[],userAuthorization:null});
  return preflight;
};

const verifyPreflight=async(runDir,{requireLiveInputs=true}={})=>{
  const target=assertRunDir(runDir);
  const preflight=await readJson(resolve(target,'preflight.json'));
  if(preflight.state!=='MODEL_DISABLED_PREPARED'||preflight.modelCalls!==0)
    throw fail('PREFLIGHT_INVALID');
  const pack=await validatePack(preflight.manifestPath);
  if(pack.manifestSha256!==preflight.manifestSha256
    ||pack.manifest.files[pack.manifest.candidate]!==preflight.candidateSha256
    ||(requireLiveInputs&&(
      sha(await readFile(preflight.clientExecutable))!==preflight.clientBinarySha256
      ||sha(await readFile(preflight.authPath))!==preflight.authSha256)))
    throw fail('PREFLIGHT_SOURCE_DRIFT');
  return {target,preflight,...pack};
};

export const verifyEvaluationConnections=async({runDir,processRunner=spawnBounded,
  toolProbe=probeMcpTools})=>{
  const {target,preflight,manifest}=await verifyPreflight(runDir);
  const rows=[];
  for(let index=0;index<preflight.arms.length;index+=manifest.concurrency){
    rows.push(...await Promise.all(preflight.arms.slice(index,index+manifest.concurrency)
      .map(async arm=>{
        const config=await readJson(arm.configPath);
        const mcpNames=Object.keys(config.mcp??{});
        const spec=buildOpenCodeInvocation({executable:preflight.clientExecutable,
          profile:manifest.client,armRoot:arm.armRoot,fixtureRoot:arm.workDir,
          configPath:arm.configPath,prompt:'model-disabled-check',
          attemptId:arm.attemptId});
        let connected=true;let exitCode=null;
        if(arm.arm==='C'){
          const check=await processRunner({executable:spec.executable,args:['mcp','list'],
            cwd:spec.cwd,env:spec.env,timeoutMs:30000});
          const output=stripVTControlCharacters(`${check.stdout??''}\n${check.stderr??''}`);
          connected=check.status===0&&!check.timedOut&&!check.outputTruncated
            &&!check.errorCode&&mcpNames.length>0
            &&mcpNames.every(name=>output.split(/\r?\n/u).some(line=>
              line.includes(name)&&/\bconnected\b/iu.test(line)));
          exitCode=check.status;
        }
        let tools=[];let contractValid=false;let contractError=null;
        if(connected){
          try{
            const contract=manifest.toolContract?.[arm.arm];
            if(!contract)throw fail('TOOL_CONTRACT_MISSING');
            const toolSets={};
            for(const name of mcpNames){
              const probed=await toolProbe({server:name,config:config.mcp[name],
                invocation:spec});
              toolSets[name]=probed.tools;
            }
            tools=assertToolContract({contract,allowedTools:manifest.allowedTools[arm.arm],
              config,toolSets});
            contractValid=true;
          }catch(error){contractError=error?.code??'TOOL_CONTRACT_PROBE_FAILED';}
        }
        return {attemptId:arm.attemptId,arm:arm.arm,mcpNames,connected,
          exitCode,configSha256:sha(await readFile(arm.configPath)),
          contractValid,contractError,tools};
      })));
  }
  const report={schemaVersion:1,
    state:rows.some(row=>!row.connected)?'MCP_CONNECTION_FAILED'
      :rows.every(row=>row.contractValid)?'MODEL_DISABLED_CONNECTED'
        :'TOOL_CONTRACT_FAILED',
    runId:preflight.runId,manifestSha256:preflight.manifestSha256,
    preflightSha256:sha(await readFile(resolve(target,'preflight.json'))),
    cArms:rows.filter(row=>row.arm==='C').length,
    cConnected:rows.filter(row=>row.arm==='C'&&row.connected).length,
    toolContractValidatedArms:rows.filter(row=>row.contractValid).length,
    modelCalls:0,rows};
  await writeJson(resolve(target,'connection-preflight.json'),report);
  return report;
};

export const executeEvaluation=async({runDir,gateMode='stop',
  continueOnRunFailure=false,transportObservation=false,
  processRunner=spawnBounded})=>{
  if(!['stop','collect'].includes(gateMode))throw fail('PAIR_GATE_MODE_INVALID');
  if(typeof continueOnRunFailure!=='boolean'
    ||(continueOnRunFailure&&gateMode!=='collect'))
    throw fail('PAIR_RUN_FAILURE_MODE_INVALID');
  if(typeof transportObservation!=='boolean')
    throw fail('TRANSPORT_OBSERVATION_INVALID');
  const {target,preflight,manifest,base}=await verifyPreflight(runDir);
  let approval;
  try{approval=await readJson(resolve(target,'approval.json'));}
  catch(error){if(error?.code==='ENOENT')throw fail('APPROVAL_REQUIRED');throw error;}
  const expectedArms=preflight.arms.map(arm=>arm.attemptId);
  if(approval.approved!==true||approval.runId!==preflight.runId
    ||approval.manifestSha256!==preflight.manifestSha256
    ||typeof approval.userAuthorization!=='string'||!approval.userAuthorization
    ||JSON.stringify(approval.approvedArmIds)!==JSON.stringify(expectedArms))
    throw fail('APPROVAL_INVALID');
  let connection;
  try{connection=await readJson(resolve(target,'connection-preflight.json'));}
  catch(error){if(error?.code==='ENOENT')throw fail('CONNECTION_PREFLIGHT_REQUIRED');throw error;}
  if(connection.state!=='MODEL_DISABLED_CONNECTED'||connection.modelCalls!==0
    ||connection.cArms!==preflight.arms.filter(arm=>arm.arm==='C').length
    ||connection.cConnected!==connection.cArms
    ||connection.toolContractValidatedArms!==preflight.arms.length
    ||connection.manifestSha256!==preflight.manifestSha256
    ||connection.rows?.length!==preflight.arms.length
    ||connection.rows.some(row=>row.contractValid!==true)
    ||connection.preflightSha256!==sha(await readFile(resolve(target,'preflight.json'))))
    throw fail('CONNECTION_PREFLIGHT_INVALID');
  if(transportObservation){
    const providerID=manifest.client.model.slice(0,
      manifest.client.model.indexOf('/'));
    for(const arm of preflight.arms){
      const config=await readJson(arm.configPath);
      const baseURL=config.provider?.[providerID]?.options?.baseURL;
      if(typeof baseURL!=='string')throw fail('TRANSPORT_UPSTREAM_MISSING');
      validateTransportBaseURL(baseURL);
    }
  }
  try{
    await writeJson(resolve(target,'run.lock.json'),{runId:preflight.runId,
      gateMode,continueOnRunFailure,transportObservation,
      approvalSha256:sha(await readFile(resolve(target,'approval.json'))),
      connectionSha256:sha(await readFile(resolve(target,'connection-preflight.json'))),
      startedAtUtc:new Date().toISOString()});
  }catch(error){
    if(error?.code==='EEXIST')throw fail('RUN_ALREADY_STARTED');
    throw error;
  }
  const preparedById=new Map(preflight.arms.map(arm=>[arm.attemptId,arm]));
  const taskById=new Map(manifest.tasks.map(task=>[task.id,task]));
  const result=await runPairSchedule({pairs:manifest.pairs,
    concurrency:manifest.concurrency,journalDir:resolve(target,'journal'),gateMode,
    continueOnRunFailure,
    allowedTools:manifest.allowedTools,
    runArm:async attempt=>{
      const prepared=preparedById.get(attempt.attemptId);
      const task=taskById.get(attempt.taskId);
      if(!prepared||!task||sha(await readFile(prepared.configPath))!==prepared.configSha256
        ||await hashTree(prepared.workDir)!==prepared.fixtureSha256
        ||sha(await readFile(preflight.authPath))!==preflight.authSha256)
        throw fail('ARM_SOURCE_DRIFT');
      const model=await runOpenCodeArm({executable:preflight.clientExecutable,
        profile:manifest.client,armRoot:prepared.armRoot,
        fixtureRoot:prepared.workDir,configPath:prepared.configPath,
        authPath:preflight.authPath,prompt:task.prompt,
        attemptId:attempt.attemptId,timeoutMs:manifest.armTimeoutMs,
        processRunner,evidenceRoot:resolve(prepared.armRoot,'evidence'),
        transportObservation});
      const runVerifier=async relativePath=>{
        const outcome=await processRunner({executable:process.execPath,
          args:[resolvePackPath(base,relativePath),prepared.workDir,task.id],
          cwd:base,env:process.env,timeoutMs:30000});
        return {exitCode:outcome.status,timedOut:outcome.timedOut===true,
          outputTruncated:outcome.outputTruncated===true};
      };
      const publicCheck=await runVerifier(task.publicVerifier);
      const hiddenCheck=await runVerifier(task.hiddenVerifier);
      return {...model,arm:attempt.arm,taskId:attempt.taskId,
        publicCheck,hiddenCheck,
        qualityPass:publicCheck.exitCode===0&&!publicCheck.timedOut
          &&!publicCheck.outputTruncated&&hiddenCheck.exitCode===0
          &&!hiddenCheck.timedOut&&!hiddenCheck.outputTruncated};
    }});
  const output={...result,continueOnRunFailure,runId:preflight.runId,
    completedAtUtc:new Date().toISOString()};
  await writeJson(resolve(target,'result.json'),output);
  return output;
};

export const auditEvaluation=async({runDir})=>{
  const {target,preflight,manifest}=await verifyPreflight(runDir,
    {requireLiveInputs:false});
  const result=await readJson(resolve(target,'result.json'));
  const runLock=await readJson(resolve(target,'run.lock.json'));
  const files=new Set(await readdir(resolve(target,'journal')));
  const rows=[];
  const issues=[];
  for(const arm of preflight.arms){
    const started=files.has(`${arm.attemptId}.started.json`);
    const settled=files.has(`${arm.attemptId}.settled.json`);
    if(started&&!settled)issues.push(`UNKNOWN_STARTED_ARM:${arm.attemptId}`);
    const receipt=settled?await readJson(resolve(target,'journal',
      `${arm.attemptId}.settled.json`)):null;
    const evidence=settled?await auditOpenCodeEvidence({receipt,
      evidenceRoot:resolve(arm.armRoot,'evidence'),profile:manifest.client,
      configPath:arm.configPath,
      requireTransportObservation:runLock.transportObservation===true}):null;
    const qualityValid=settled&&receipt.qualityPass===true
      &&receipt.publicCheck?.exitCode===0&&!receipt.publicCheck?.timedOut
      &&receipt.hiddenCheck?.exitCode===0&&!receipt.hiddenCheck?.timedOut;
    const boundaryValid=settled&&Array.isArray(receipt.toolNames)
      &&receipt.toolNames.every(name=>manifest.allowedTools[arm.arm].includes(name));
    const effectsKnown=settled&&receipt.sideEffectStatus==='KNOWN_COMPLETED'
      &&receipt.authSourceSha256===preflight.authSha256
      &&!await exists(resolve(arm.armRoot,'xdg-data/opencode/auth.json'));
    if(settled&&(!evidence.valid||!qualityValid||!boundaryValid||!effectsKnown))
      issues.push(`ARM_AUDIT_FAILED:${arm.attemptId}`);
    rows.push({attemptId:arm.attemptId,pairId:arm.pairId,
      arm:arm.arm,started,settled,receipt,
      evidenceValid:evidence?.valid??null,qualityValid,boundaryValid,effectsKnown});
  }
  const pairRows=manifest.pairs.map(pair=>{
    const a=rows.find(x=>x.pairId===pair.id&&x.arm==='A');
    const c=rows.find(x=>x.pairId===pair.id&&x.arm==='C');
    const complete=a?.settled===true&&c?.settled===true;
    const qualityPass=complete&&a.qualityValid&&c.qualityValid
      &&a.evidenceValid&&c.evidenceValid&&a.boundaryValid&&c.boundaryValid
      &&a.effectsKnown&&c.effectsKnown;
    const tokenPass=complete&&c.receipt.normalizedUsage.rawTotal
      <a.receipt.normalizedUsage.rawTotal;
    return {pairId:pair.id,complete,qualityPass,tokenPass,
      aRawTotal:a?.receipt?.normalizedUsage?.rawTotal??null,
      cRawTotal:c?.receipt?.normalizedUsage?.rawTotal??null};
  });
  const allPass=result.state==='complete'&&issues.length===0
    &&pairRows.every(pair=>pair.complete&&pair.qualityPass&&pair.tokenPass);
  const report={schemaVersion:1,runId:preflight.runId,
    state:allPass?'PAIR_GATE_PASS':'PAIR_GATE_NOT_PASSED',
    schedulerState:result.state,schedulerReason:result.reason,
    plannedPairs:manifest.pairs.length,completePairs:pairRows.filter(x=>x.complete).length,
    passingPairs:pairRows.filter(x=>x.complete&&x.qualityPass&&x.tokenPass).length,
    startedArms:rows.filter(x=>x.started).length,
    settledArms:rows.filter(x=>x.settled).length,
    modelCalls:rows.reduce((n,x)=>n+(x.receipt?.modelInvocationCount??0),0),
    knownCostUsd:rows.reduce((n,x)=>n+(x.receipt?.costUsd??0),0),
    pairRows,issues,manifestSha256:preflight.manifestSha256,
    candidateSha256:preflight.candidateSha256};
  await writeJson(resolve(target,'postflight.json'),report);
  return report;
};

export const assessEvaluation=async({runDir})=>{
  const {target,preflight,manifest}=await verifyPreflight(runDir,
    {requireLiveInputs:false});
  let bytes;
  try{bytes=await readFile(resolve(target,'postflight.json'));}
  catch(error){
    if(error?.code==='ENOENT')throw fail('POSTFLIGHT_REQUIRED');
    throw error;
  }
  const postflight=JSON.parse(bytes.toString('utf8'));
  if(postflight.runId!==preflight.runId
    ||postflight.manifestSha256!==preflight.manifestSha256
    ||postflight.candidateSha256!==preflight.candidateSha256)
    throw fail('POSTFLIGHT_SOURCE_DRIFT');
  return {...assessReplicatedAudit({manifest,postflight}),
    runId:preflight.runId,manifestSha256:preflight.manifestSha256,
    candidateSha256:preflight.candidateSha256,postflightSha256:sha(bytes)};
};
