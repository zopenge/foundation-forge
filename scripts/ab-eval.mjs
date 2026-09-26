import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { diagnoseEvaluation } from './ab-eval/diagnostics.mjs';
import { freezePack, slicePack, validatePack } from './ab-eval/manifest.mjs';
import { probeOpenCodeClient, spawnBounded } from './ab-eval/opencode.mjs';
import { inspectEvaluationStatus } from './ab-eval/status.mjs';
import { probeTransportObservation } from './ab-eval/transport-doctor.mjs';
import { assessEvaluation, auditEvaluation, executeEvaluation, prepareEvaluation,
  verifyEvaluationConnections } from './ab-eval/workflow.mjs';

const usage='Usage: node scripts/ab-eval.mjs '
  +'freeze --draft PATH --out PATH | verify-pack --manifest PATH | '
  +'slice --manifest PATH --pairs ID,ID --id ID --out PATH | '
  +'client-version --local PATH | '
  +'client-doctor --local PATH | '
  +'transport-doctor --executable PATH --out NEW_PATH | '
  +'prepare --manifest PATH --run-dir PATH --local PATH | '
  +'doctor --run-dir PATH | status --run-dir PATH | '
  +'run --run-dir PATH [--gate-mode stop|collect] [--continue-on-run-failure on] '
  +'[--observe-transport on] | audit --run-dir PATH | '
  +'assess --run-dir PATH | '
  +'diagnose --run-dir PATH [--report-dir NEW_PATH]';
const fail=code=>Object.assign(new Error(code),{code});
const parseArgs=argv=>{
  const [command,...rest]=argv;
  if(command==='--help'||command==='help')return {command:'help',options:{}};
  if(!['freeze','verify-pack','slice','client-version','client-doctor',
    'transport-doctor',
    'prepare','doctor','status','run','audit','assess','diagnose'].includes(command)
    ||rest.length%2!==0)throw fail('AB_EVAL_ARGUMENT_INVALID');
  const options={};
  for(let index=0;index<rest.length;index+=2){
    const key=rest[index];
    if(!/^--[a-z-]+$/u.test(key)||key in options||!rest[index+1])
      throw fail('AB_EVAL_ARGUMENT_INVALID');
    options[key.slice(2)]=rest[index+1];
  }
  return {command,options};
};
const requireOptions=(options,names)=>{
  if(Object.keys(options).length!==names.length
    ||names.some(name=>typeof options[name]!=='string'))
    throw fail('AB_EVAL_ARGUMENT_INVALID');
};
const readLocal=async path=>{
  const value=JSON.parse(await readFile(path,'utf8'));
  if(typeof value.clientExecutable!=='string'||!value.clientExecutable
    ||typeof value.authPath!=='string'||!value.authPath)
    throw fail('AB_EVAL_LOCAL_CONFIG_INVALID');
  return value;
};

export const main=async(argv=process.argv.slice(2))=>{
  const {command,options}=parseArgs(argv);
  if(command==='help')return {state:'HELP',usage};
  if(command==='freeze'){
    requireOptions(options,['draft','out']);
    const manifest=await freezePack({draftPath:options.draft,outputPath:options.out});
    const checked=await validatePack(options.out);
    return {state:'PACK_FROZEN',id:manifest.id,
      files:Object.keys(manifest.files).length,sha256:checked.manifestSha256};
  }
  if(command==='verify-pack'){
    requireOptions(options,['manifest']);
    const checked=await validatePack(options.manifest);
    return {state:'PACK_VALID',id:checked.manifest.id,
      files:Object.keys(checked.manifest.files).length,sha256:checked.manifestSha256};
  }
  if(command==='slice'){
    requireOptions(options,['manifest','pairs','id','out']);
    const result=await slicePack({manifestPath:options.manifest,
      outputDir:options.out,id:options.id,pairIds:options.pairs.split(',')});
    return {state:'PACK_SLICED',path:result.path,id:result.manifest.id,
      pairs:result.manifest.pairs.length,manifestSha256:result.manifestSha256};
  }
  if(command==='client-version'){
    requireOptions(options,['local']);
    const local=await readLocal(options.local);
    const result=await spawnBounded({executable:local.clientExecutable,args:['--version'],
      cwd:process.cwd(),env:process.env,timeoutMs:30000});
    if(result.status!==0||result.timedOut||result.outputTruncated)
      throw fail('OPENCODE_VERSION_PROBE_FAILED');
    return {state:'CLIENT_VERSION',version:result.stdout.trim()};
  }
  if(command==='client-doctor'){
    requireOptions(options,['local']);
    const local=await readLocal(options.local);
    return probeOpenCodeClient({executable:local.clientExecutable,
      tempRoot:resolve(import.meta.dirname,'../.tmp')});
  }
  if(command==='transport-doctor'){
    requireOptions(options,['executable','out']);
    return probeTransportObservation({executable:options.executable,
      outputDir:options.out});
  }
  if(command==='prepare'){
    requireOptions(options,['manifest','run-dir','local']);
    const local=await readLocal(options.local);
    const result=await prepareEvaluation({manifestPath:options.manifest,
      runDir:options['run-dir'],clientExecutable:local.clientExecutable,
      authPath:local.authPath});
    return {state:result.state,runId:result.runId,arms:result.arms.length,
      manifestSha256:result.manifestSha256,modelCalls:result.modelCalls};
  }
  if(command==='run'){
    requireOptions(options,['run-dir',
      ...(options['gate-mode']!==undefined?['gate-mode']:[]),
      ...(options['continue-on-run-failure']!==undefined
        ?['continue-on-run-failure']:[]),
      ...(options['observe-transport']!==undefined?['observe-transport']:[])]);
    if(options['continue-on-run-failure']!==undefined
      &&options['continue-on-run-failure']!=='on')
      throw fail('AB_EVAL_ARGUMENT_INVALID');
    if(options['observe-transport']!==undefined
      &&options['observe-transport']!=='on')
      throw fail('AB_EVAL_ARGUMENT_INVALID');
  }else requireOptions(options,command==='diagnose'
    &&options['report-dir']!==undefined?['run-dir','report-dir']:['run-dir']);
  if(command==='status')return inspectEvaluationStatus({runDir:options['run-dir']});
  if(command==='doctor'){
    const result=await verifyEvaluationConnections({runDir:options['run-dir']});
    return {state:result.state,runId:result.runId,cArms:result.cArms,
      cConnected:result.cConnected,
      toolContractValidatedArms:result.toolContractValidatedArms,
      modelCalls:result.modelCalls};
  }
  if(command==='run'){
    const result=await executeEvaluation({runDir:options['run-dir'],
      gateMode:options['gate-mode']??'stop',
      continueOnRunFailure:options['continue-on-run-failure']==='on',
      transportObservation:options['observe-transport']==='on'});
    return {state:result.state,reason:result.reason,runId:result.runId,
      settledArms:result.settledArms,gateMode:result.gateMode,
      gateFailures:result.gateFailures.length,armErrors:result.armErrors.length};
  }
  if(command==='diagnose'){
    const result=await diagnoseEvaluation({runDir:options['run-dir'],
      reportDir:options['report-dir']});
    return {state:result.state,runId:result.runId,
      completePairs:result.completePairs,issues:result.issues.length,
      path:resolve(options['report-dir']??options['run-dir'],'diagnostics.json')};
  }
  if(command==='assess')return assessEvaluation({runDir:options['run-dir']});
  const result=await auditEvaluation({runDir:options['run-dir']});
  return {state:result.state,runId:result.runId,
    completePairs:result.completePairs,passingPairs:result.passingPairs,
    modelCalls:result.modelCalls,knownCostUsd:result.knownCostUsd};
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const result=await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if(process.argv[2]!=='status'
      &&['stopped','blocked','PAIR_GATE_NOT_PASSED',
        'REPLICATED_GATE_NOT_PASSED','REPLICATED_GATE_INELIGIBLE',
        'MCP_CONNECTION_FAILED',
        'TOOL_CONTRACT_FAILED'].includes(result.state))
      process.exitCode=2;
  }catch(error){
    process.stdout.write(`${JSON.stringify({state:'BLOCKED',code:error?.code??'AB_EVAL_FAILED'})}\n`);
    process.exitCode=1;
  }
}
