import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, readdir,
  writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { collectRelativeModuleClosure } from '../../../scripts/ab-eval/module-closure.mjs';
import { freezePack, validatePack } from '../../../scripts/ab-eval/manifest.mjs';

const repoRoot=resolve(import.meta.dirname,'../../..');
const sourceRoot=resolve(repoRoot,'.tmp');
const optimizationRoot=resolve(sourceRoot,'repository-context-optimization-v3');
const labRoot=resolve(sourceRoot,'repository-context-lab');
const fail=code=>Object.assign(new Error(code),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const inside=(base,path)=>path===base||path.startsWith(base+sep);
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const writeJson=(path,value)=>writeFile(path,`${JSON.stringify(value,null,2)}\n`,
  {encoding:'utf8',flag:'wx'});
const formalTaskSchemas={
  replace_text:'734043F61D99E1CF89260CE1C10177CE60FC9BCEEAF1FC42CFA61BE816774332',
};
const repositoryContextSchemas={
  investigate:'E102E65840F2F86D96DB5BD5C9C5C14BAC6D0FDCA4C89AAAEDACB23B5ACD29E7',
  read:'193F0E70DC2894797900234838240D418F690F1A0EE3CDE9655B9127173C9798',
  continue:'7238C1DBC53552DC7A1858974E2AD6C60E5230921A0B0267AB04F75608743C2D',
};
export const h8ToolPolicy=arm=>{
  if(!['A','C'].includes(arm))throw fail('H8_ARM_INVALID');
  // 两臂仅开放会自动执行公开测试的编辑工具，省去冗余测试和记事回合。
  const native=arm==='A'?['read','glob','grep']:[];
  const mcp=arm==='A'?{formal_task:formalTaskSchemas}
    :{formal_task:formalTaskSchemas,repository_context:repositoryContextSchemas};
  const allowedTools=[...native,...Object.entries(mcp).flatMap(([server,tools])=>
    Object.keys(tools).map(name=>`${server}_${name}`))];
  return {allowedTools,toolContract:{native,mcp},
    permission:Object.fromEntries([['*','deny'],
      ...allowedTools.map(name=>[name,'allow']),['external_directory','deny']])};
};
const copyFile=async(source,target)=>{
  await mkdir(dirname(target),{recursive:true});
  await cp(source,target,{force:false,errorOnExist:true});
};

const hashTree=async root=>{
  const rows=[];
  const walk=async(rel='')=>{
    const dir=rel?resolve(root,...rel.split('/')):root;
    for(const entry of (await readdir(dir,{withFileTypes:true}))
      .sort((a,b)=>a.name.localeCompare(b.name))){
      const next=rel?`${rel}/${entry.name}`:entry.name;
      const path=resolve(root,...next.split('/'));
      const info=await lstat(path);
      if(info.isSymbolicLink())throw fail('H8_TASK_FREEZE_DRIFT');
      if(info.isDirectory())await walk(next);
      else if(info.isFile())rows.push({path:next,sha256:sha(await readFile(path))});
      else throw fail('H8_TASK_FREEZE_DRIFT');
    }
  };
  await walk();
  return sha(JSON.stringify(rows));
};

export const assertFrozenTaskSource=async({baseRoot,manifestPath,hiddenPath,expected})=>{
  const values=[
    [manifestPath,expected.manifestSha256],
    [resolve(baseRoot,'public-test.mjs'),expected.publicTestSha256],
    [hiddenPath,expected.hiddenVerifierSha256],
  ];
  for(const [path,digest] of values){
    if(sha(await readFile(path))!==digest)throw fail('H8_TASK_FREEZE_DRIFT');
  }
  if(expected.baseTreeDigest&&await hashTree(baseRoot)!==expected.baseTreeDigest)
    throw fail('H8_TASK_FREEZE_DRIFT');
};

const copyRuntimeModules=async output=>{
  const legacySeeds=[
    'repository-context-optimization-v3/evaluation/formal-task-mcp.mjs',
    'repository-context-lab/evaluation/live-tools.mjs',
    'repository-context-lab/evaluation/foundation-ts-runner.mjs',
    'repository-context-optimization-v3/scripts/foundation-context-v82-mcp-stdio.mjs',
  ];
  const legacyClosure=await collectRelativeModuleClosure({root:sourceRoot,
    seeds:legacySeeds});
  for(const path of legacyClosure)await copyFile(resolve(sourceRoot,path),
    resolve(output,'runtime',path));
  const stableClosure=await collectRelativeModuleClosure({root:repoRoot,
    seeds:['scripts/ab-eval/formal-task-filtered-stdio.mjs']});
  for(const path of stableClosure)await copyFile(resolve(repoRoot,path),
    resolve(output,'runtime',path));
  return [...legacyClosure,...stableClosure].sort();
};

const copyInstalledDependencies=async({sourcePackage,output})=>{
  const installed=resolve(sourcePackage,'node_modules');
  const destination=resolve(output,'runtime/consumer/package/node_modules');
  const pending=Object.keys((await json(resolve(sourcePackage,'package.json'))).dependencies??{});
  const seen=new Set();
  while(pending.length>0){
    const name=pending.pop();
    if(seen.has(name))continue;
    if(!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name))
      throw fail('H8_DEPENDENCY_NAME_INVALID');
    seen.add(name);
    const path=resolve(installed,...name.split('/'));
    const actual=await realpath(path);
    if(!(await lstat(actual)).isDirectory())throw fail('H8_DEPENDENCY_MISSING');
    const packageJson=await json(resolve(actual,'package.json'));
    pending.push(...Object.keys(packageJson.dependencies??{}));
    const target=resolve(destination,...name.split('/'));
    await mkdir(dirname(target),{recursive:true});
    await cp(actual,target,{recursive:true,dereference:true,
      force:false,errorOnExist:true});
  }
  const typescript=resolve(destination,'typescript');
  await mkdir(resolve(output,'runtime/node_modules'),{recursive:true});
  await cp(typescript,resolve(output,'runtime/node_modules/typescript'),
    {recursive:true,dereference:true,force:false,errorOnExist:true});
  return [...seen].sort();
};

const copyCandidate=async({packet,output})=>{
  const archive=resolve(repoRoot,packet.candidate.path);
  if(!inside(sourceRoot,archive)
    ||sha(await readFile(archive))!==packet.candidate.sha256)
    throw fail('H8_CANDIDATE_DRIFT');
  await copyFile(archive,resolve(output,'candidate.tgz'));
  const sourcePackage=resolve(dirname(archive),'consumer/package');
  const sourceCli=resolve(sourcePackage,'dist/node/cli.js');
  if(sha(await readFile(sourceCli))!==packet.candidate.cliSha256)
    throw fail('H8_CANDIDATE_CLI_DRIFT');
  const target=resolve(output,'runtime/consumer/package');
  await mkdir(target,{recursive:true});
  await cp(resolve(sourcePackage,'dist'),resolve(target,'dist'),
    {recursive:true,dereference:true,force:false,errorOnExist:true});
  await copyFile(resolve(sourcePackage,'package.json'),resolve(target,'package.json'));
  const dependencies=await copyInstalledDependencies({sourcePackage,output});
  return {archiveSha256:packet.candidate.sha256,
    cliSha256:packet.candidate.cliSha256,dependencies};
};

const copyTasks=async({packet,output})=>{
  const prep=await json(resolve(optimizationRoot,
    'evaluation/manifests/fro08-sol-formal-v41-prep.json'));
  if(prep.taskFreeze?.taskSetDigest!==packet.protocol.taskSetDigest)
    throw fail('H8_TASK_SET_DRIFT');
  const frozenById=new Map(prep.taskFreeze.tasks.map(task=>[task.id,task]));
  const prompts=new Map();
  for(const pair of packet.pairs){
    if(pair.arms?.length!==2||pair.arms.some(arm=>arm.prompt!==pair.arms[0].prompt))
      throw fail('H8_PAIR_PROMPT_DRIFT');
    const previous=prompts.get(pair.taskId);
    if(previous!==undefined&&previous!==pair.arms[0].prompt)
      throw fail('H8_TASK_PROMPT_DRIFT');
    prompts.set(pair.taskId,pair.arms[0].prompt);
  }
  const tasks=[];
  for(const id of packet.taskOrder){
    if(!/^[a-z0-9][a-z0-9-]*$/u.test(id)||!prompts.has(id))
      throw fail('H8_TASK_ID_INVALID');
    const old=await json(resolve(labRoot,'arms/fvc05-formal',id,'manifest.json'));
    if(old.id!==id||!Array.isArray(old.packages)||old.packages.length===0)
      throw fail('H8_TASK_SOURCE_INVALID');
    const base=resolve(old.baseRoot);
    if(!inside(sourceRoot,base))throw fail('H8_TASK_SOURCE_OUTSIDE_ROOT');
    const manifestPath=resolve(labRoot,'arms/fvc05-formal',id,'manifest.json');
    const hiddenPath=resolve(labRoot,'evaluator-private/fvc05-formal',`${id}.mjs`);
    const frozen=frozenById.get(id);
    if(!frozen)throw fail('H8_TASK_FREEZE_MISSING');
    await assertFrozenTaskSource({baseRoot:base,manifestPath,hiddenPath,expected:frozen});
    const fixture=`fixtures/${id}`;
    await cp(base,resolve(output,fixture),{recursive:true,dereference:false,
      force:false,errorOnExist:true});
    await copyFile(hiddenPath,resolve(output,'verifiers/hidden',`${id}.mjs`));
    await mkdir(resolve(output,'metadata/tasks'),{recursive:true});
    await writeJson(resolve(output,'metadata/tasks',`${id}.json`),{
      id,packages:old.packages,targetFiles:old.targetFiles,
      sourceManifestSha256:frozen.manifestSha256,
    });
    tasks.push({id,fixture,setup:'setup.mjs',prompt:prompts.get(id),
      publicVerifier:'verifiers/public.mjs',
      hiddenVerifier:'verifiers/hidden.mjs'});
  }
  return tasks;
};

const buildConfigs=async({packet,output,legacyRunRoot})=>{
  const pair=packet.pairs[0];
  const old={};
  for(const arm of ['A','C']){
    const attempt=pair.arms.find(item=>item.arm===arm);
    old[arm]=await json(resolve(legacyRunRoot,'arms',attempt.attemptId,
      'opencode-eval.json'));
  }
  const formal={type:'local',command:['{{NODE}}',
    '{{PACK_DIR}}/runtime/scripts/ab-eval/formal-task-filtered-stdio.mjs'],
  enabled:true,timeout:30000,environment:{FRO_FORMAL_ROOT:'{{WORK_DIR}}',
    FRO_FORMAL_RUNTIME_ROOT:'{{PACK_DIR}}/runtime'}};
  const context={type:'local',command:['{{NODE}}',
    '{{PACK_DIR}}/runtime/repository-context-optimization-v3/scripts/foundation-context-v82-mcp-stdio.mjs'],
  enabled:true,timeout:30000,environment:{
    FRO_RC_CLI_JS:'{{PACK_DIR}}/runtime/consumer/package/dist/node/cli.js',
    FRO_RC_ROOT:'{{WORK_DIR}}',
    FRO_RC_INDEX:'{{ARM_DIR}}/repository-context-index',
  }};
  for(const arm of ['A','C']){
    const policy=h8ToolPolicy(arm);
    await mkdir(resolve(output,'config'),{recursive:true});
    await writeJson(resolve(output,'config',`${arm.toLowerCase()}.json`),{
      $schema:'https://opencode.ai/config.json',
      provider:old[arm].provider,permission:policy.permission,
      mcp:arm==='A'?{formal_task:formal}:
        {formal_task:formal,repository_context:context},
    });
  }
  const provider=Object.keys(old.A.provider??{});
  if(provider.length!==1||JSON.stringify(old.A.provider)!==JSON.stringify(old.C.provider))
    throw fail('H8_PROVIDER_CONFIG_DRIFT');
  return provider[0];
};

export const exportH8Pack=async({outputDir,clientVersion,
  packetPath=resolve(optimizationRoot,'evaluation/manifests/fro08-v85-full-closed.json'),
  legacyRunRoot=resolve(optimizationRoot,'runs/fro08-formal-sol-opencode-high-063-full')})=>{
  const output=resolve(outputDir);
  if(!inside(sourceRoot,output)||output===sourceRoot
    ||typeof clientVersion!=='string'||!/^\d+\.\d+\.\d+$/u.test(clientVersion))
    throw fail('H8_EXPORT_ARGUMENT_INVALID');
  const packet=await json(packetPath);
  if(packet.pairs?.length!==24||packet.taskOrder?.length!==8
    ||packet.candidate?.sha256!==
      '95127183010B99844CC3E35F80602DBD4C7B97DD66FD87E53CD2D0699010EC57')
    throw fail('H8_PACKET_IDENTITY_INVALID');
  await mkdir(dirname(output),{recursive:true});
  await mkdir(output,{recursive:false});
  const candidate=await copyCandidate({packet,output});
  const runtimeModules=await copyRuntimeModules(output);
  const tasks=await copyTasks({packet,output});
  const provider=await buildConfigs({packet,output,legacyRunRoot});
  await copyFile(resolve(import.meta.dirname,'h8-setup.mjs'),resolve(output,'setup.mjs'));
  await copyFile(resolve(import.meta.dirname,'h8-verify-public.mjs'),
    resolve(output,'verifiers/public.mjs'));
  await copyFile(resolve(import.meta.dirname,'h8-verify-hidden.mjs'),
    resolve(output,'verifiers/hidden.mjs'));
  const draft={schemaVersion:1,id:'h8-v85-portable',candidate:'candidate.tgz',
    client:{kind:'opencode',version:clientVersion,
      model:`${provider}/${packet.model}`,variant:packet.effort,agent:'build'},
    configs:{A:'config/a.json',C:'config/c.json'},tasks,
    pairs:packet.pairs.map(pair=>({id:pair.id,taskId:pair.taskId,order:pair.order})),
    concurrency:packet.concurrency,
    armTimeoutMs:packet.executionPolicy.armTimeoutMs,
    allowedTools:{A:h8ToolPolicy('A').allowedTools,
      C:h8ToolPolicy('C').allowedTools},
    toolContract:{A:h8ToolPolicy('A').toolContract,
      C:h8ToolPolicy('C').toolContract}};
  await writeJson(resolve(output,'source.json'),{
    sourceRunId:packet.runId,sourceProtocolDigest:packet.protocol.protocolDigest,
    taskSetDigest:packet.protocol.taskSetDigest,candidate,runtimeModules,
    evaluationClass:'regression-only',
  });
  await writeJson(resolve(output,'draft.json'),draft);
  const frozen=await freezePack({draftPath:resolve(output,'draft.json'),
    outputPath:resolve(output,'pack.json')});
  const checked=await validatePack(resolve(output,'pack.json'));
  return {state:'H8_PACK_EXPORTED',path:resolve(output,'pack.json'),
    manifestSha256:checked.manifestSha256,candidateSha256:candidate.archiveSha256,
    tasks:frozen.tasks.length,pairs:frozen.pairs.length,
    files:Object.keys(frozen.files).length,dependencies:candidate.dependencies.length};
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [flag,outputDir,versionFlag,clientVersion]=process.argv.slice(2);
  if(flag!=='--out'||versionFlag!=='--client-version'||!outputDir||!clientVersion)
    throw fail('H8_EXPORT_ARGUMENT_INVALID');
  process.stdout.write(`${JSON.stringify(await exportH8Pack({outputDir,clientVersion}))}\n`);
}
