import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const fail=code=>Object.assign(new Error(code),{code});
const defaultRunner=spec=>spawnSync(spec.executable,spec.args,{
  cwd:spec.cwd,encoding:'utf8',windowsHide:true,timeout:spec.timeoutMs,
  maxBuffer:8*1024*1024,shell:false});

export const prepareH8Arm=async({packRoot,workDir,armRoot,arm,taskId,
  processRunner=defaultRunner})=>{
  if(!['A','C'].includes(arm)||!/^[a-z0-9][a-z0-9-]*$/u.test(taskId))
    throw fail('H8_SETUP_ARGUMENT_INVALID');
  const tsconfig={compilerOptions:{target:'ES2022',module:'NodeNext',
    moduleResolution:'NodeNext',allowJs:true,checkJs:false,noEmit:true,
    skipLibCheck:true},include:['packages/**/*.ts']};
  await writeFile(resolve(workDir,'tsconfig.json'),
    `${JSON.stringify(tsconfig,null,2)}\n`,{flag:'wx'});
  if(arm==='A')return {state:'READY',indexBuilt:false};
  const task=JSON.parse(await readFile(resolve(packRoot,'metadata','tasks',
    `${taskId}.json`),'utf8'));
  if(!Array.isArray(task.packages)||task.packages.length===0
    ||task.packages.some(name=>!/^[a-z0-9][a-z0-9-]*$/u.test(name)))
    throw fail('H8_TASK_METADATA_INVALID');
  const cli=resolve(packRoot,'runtime/consumer/package/dist/node/cli.js');
  const args=[cli,'build','--root',workDir,'--index',
    resolve(armRoot,'repository-context-index'),'--corpus',`h8-${taskId}`,
    '--tsconfig',resolve(workDir,'tsconfig.json')];
  for(const name of task.packages)args.push('--scope',`packages/${name}/src`);
  args.push('--language','typescript');
  const result=await processRunner({executable:process.execPath,args,
    cwd:workDir,timeoutMs:60000});
  let output;
  try{output=JSON.parse(result.stdout??'');}catch{throw fail('H8_INDEX_BUILD_FAILED');}
  if(result.status!==0||result.error||result.timedOut||result.outputTruncated
    ||output?.status!=='ok')throw fail('H8_INDEX_BUILD_FAILED');
  return {state:'READY',indexBuilt:true,
    corpusId:output.corpusId??null,generationId:output.generationId??null};
};

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [workDir,armRoot,candidatePath,arm,taskId]=process.argv.slice(2);
  if(!candidatePath)throw fail('H8_SETUP_ARGUMENT_INVALID');
  const result=await prepareH8Arm({packRoot:import.meta.dirname,
    workDir,armRoot,arm,taskId});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
