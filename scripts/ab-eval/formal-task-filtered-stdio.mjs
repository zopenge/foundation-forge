import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { projectMcpBridge } from './mcp-tool-projection.mjs';

const root=process.env.FRO_FORMAL_ROOT;
const runtimeRoot=process.env.FRO_FORMAL_RUNTIME_ROOT;
if(!root||!runtimeRoot){
  process.stderr.write('FORMAL_TASK_MCP_ENV_MISSING\n');
  process.exit(2);
}
const load=path=>import(pathToFileURL(resolve(runtimeRoot,path)).href);
const [{createArmToolHost},{runFoundationTypeScript},
  {createFormalTaskMcpBridge}]=await Promise.all([
  load('repository-context-lab/evaluation/live-tools.mjs'),
  load('repository-context-lab/evaluation/foundation-ts-runner.mjs'),
  load('repository-context-optimization-v3/evaluation/formal-task-mcp.mjs'),
]);
const host=createArmToolHost({root,
  runPublicTest:async()=>{
    const result=await runFoundationTypeScript({script:join(root,'public-test.mjs'),
      cwd:root,timeoutMs:30000});
    return {exitCode:result.exitCode,timedOut:result.timedOut,
      summary:(result.stdout||result.stderr).slice(-2000)};
  },
});
const bridge=projectMcpBridge({bridge:createFormalTaskMcpBridge({host}),
  allowedNames:['replace_text']});
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
  if(!line.trim())continue;
  let message;
  try{message=JSON.parse(line);}
  catch{
    process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:null,
      error:{code:-32700,message:'Parse error'}})}\n`);
    continue;
  }
  const response=await bridge.handle(message);
  if(response!==null)process.stdout.write(`${JSON.stringify(response)}\n`);
}
