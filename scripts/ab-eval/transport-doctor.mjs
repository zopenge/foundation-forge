import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { auditOpenCodeEvidence, runOpenCodeArm, spawnBounded } from './opencode.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const within=(base,target)=>{
  const part=relative(base,target);
  return part!==''&&part!=='..'&&!part.startsWith(`..${sep}`)
    &&!isAbsolute(part);
};
const fakeChunk=(choices,usage)=>JSON.stringify({id:'chatcmpl-transport-probe',
  object:'chat.completion.chunk',created:0,model:'model',choices,
  ...(usage?{usage}:{})});

export const probeTransportObservation=async({executable,outputDir,
  processRunner=spawnBounded})=>{
  const output=resolve(outputDir);
  const temp=await realpath(resolve(import.meta.dirname,'../..','.tmp'));
  const parent=await realpath(dirname(output));
  if(!within(temp,output)||!(parent===temp||within(temp,parent)))
    throw fail('TRANSPORT_PROBE_OUTPUT_OUTSIDE_TEMP');
  await mkdir(output);
  const versionResult=await processRunner({executable,args:['--version'],
    cwd:output,env:process.env,timeoutMs:30000});
  const version=versionResult.stdout?.trim();
  if(versionResult.status!==0||versionResult.timedOut
    ||versionResult.outputTruncated||versionResult.errorCode||!version)
    throw fail('OPENCODE_VERSION_PROBE_FAILED');
  let requestCount=0;
  const provider=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){
      res.writeHead(404);res.end();return;
    }
    requestCount+=1;
    for await(const chunk of req)void chunk;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(`data: ${fakeChunk([{index:0,delta:{role:'assistant',
      content:'OK'},finish_reason:null}])}\n\n`);
    res.write(`data: ${fakeChunk([{index:0,delta:{},
      finish_reason:'stop'}])}\n\n`);
    res.end(`data: ${fakeChunk([],{prompt_tokens:17,
      completion_tokens:2,total_tokens:19})}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0,'127.0.0.1');
  await once(provider,'listening');
  const armRoot=resolve(output,'arm');
  const fixtureRoot=resolve(armRoot,'work');
  const configPath=resolve(armRoot,'opencode.json');
  const authPath=resolve(output,'fake-auth.json');
  const evidenceRoot=resolve(armRoot,'evidence');
  const profile={version,model:'transportprobe/model',variant:'high',agent:'build'};
  try{
    await mkdir(fixtureRoot,{recursive:true});
    await writeFile(configPath,`${JSON.stringify({
      $schema:'https://opencode.ai/config.json',
      provider:{transportprobe:{name:'Local transport probe',
        npm:'@ai-sdk/openai-compatible',options:{
          baseURL:`http://127.0.0.1:${provider.address().port}/v1`},
        models:{model:{name:'Local fake model',reasoning:false}}}},
      permission:{'*':'deny'},
    },null,2)}\n`,{flag:'wx'});
    await writeFile(authPath,'{"transportprobe":{"type":"api","key":"fake-key"}}\n',
      {flag:'wx'});
    const receipt=await runOpenCodeArm({executable,profile,armRoot,fixtureRoot,
      configPath,authPath,prompt:'Reply with OK. Do not use tools.',
      attemptId:'transport-probe-A',timeoutMs:30000,processRunner,
      evidenceRoot,transportObservation:true});
    const audit=await auditOpenCodeEvidence({receipt,evidenceRoot,profile,
      configPath,requireTransportObservation:true});
    if(!audit.valid||requestCount<1
      ||receipt.transportObservation?.requestCount!==requestCount)
      throw fail('TRANSPORT_PROBE_AUDIT_FAILED');
    const evidence=JSON.parse(await readFile(resolve(evidenceRoot,
      'transport.json'),'utf8'));
    if(evidence.records.some(row=>row.usage===null))
      throw fail('TRANSPORT_PROBE_USAGE_MISSING');
    if(evidence.records.some(row=>row.requestShape?.format!=='json-object'))
      throw fail('TRANSPORT_PROBE_SHAPE_MISSING');
    return {state:'TRANSPORT_PROBE_PASS',version,requestCount,
      modelCalls:receipt.modelInvocationCount,
      evidencePath:resolve(evidenceRoot,'transport.json')};
  }finally{
    await rm(authPath,{force:true});
    await new Promise((resolvePromise,reject)=>{
      provider.closeIdleConnections();
      provider.close(error=>error?reject(error):resolvePromise());
    });
  }
};
