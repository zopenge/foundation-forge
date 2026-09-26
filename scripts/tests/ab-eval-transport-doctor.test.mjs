import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { main } from '../ab-eval.mjs';
import { probeTransportObservation } from '../ab-eval/transport-doctor.mjs';

test('transport doctor CLI requires an explicit executable and new output path',async()=>{
  await assert.rejects(main(['transport-doctor','--executable','opencode']),
    {code:'AB_EVAL_ARGUMENT_INVALID'});
  await assert.rejects(main(['transport-doctor','--executable','opencode',
    '--out',resolve('outside-temp')]),
    {code:'TRANSPORT_PROBE_OUTPUT_OUTSIDE_TEMP'});
});

test('transport doctor uses an isolated fake provider and retains sanitized evidence',async()=>{
  await mkdir(resolve('.tmp'),{recursive:true});
  const parent=await mkdtemp(resolve('.tmp','transport-doctor-test-'));
  const outputDir=resolve(parent,'probe');
  const calls=[];
  try{
    const processRunner=async spec=>{
      calls.push(spec.args[0]);
      if(spec.args[0]==='--version')
        return {status:0,stdout:'1.18.30\n'};
      if(spec.args[0]==='debug'){
        const config=JSON.parse(await readFile(spec.env.OPENCODE_CONFIG,'utf8'));
        const inline=JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(inline.provider.transportprobe.options.baseURL,
          config.provider.transportprobe.options.baseURL);
        return {status:0,stdout:JSON.stringify(config)};
      }
      if(spec.args[0]==='run'){
        const config=JSON.parse(await readFile(spec.env.OPENCODE_CONFIG,'utf8'));
        const endpoint=config.provider.transportprobe.options.baseURL;
        const response=await globalThis.fetch(`${endpoint}/chat/completions`,{
          method:'POST',body:'{"messages":[{"content":"fake only"}]}' });
        assert.equal(response.status,200);
        assert.match(await response.text(),/chat\.completion\.chunk/u);
        return {status:0,stdout:JSON.stringify({sessionID:'ses_probe',
          type:'step_finish',part:{type:'step-finish',cost:0,
            tokens:{input:17,output:2,reasoning:0,
              cache:{read:0,write:0}}}})+'\n'};
      }
      return {status:0,stdout:JSON.stringify({info:{id:'ses_probe',
        version:'1.18.30',model:{providerID:'transportprobe',id:'model'}},
      messages:[{info:{role:'assistant',providerID:'transportprobe',
        modelID:'model',variant:'high',cost:0,tokens:{input:17,
          output:2,reasoning:0,cache:{read:0,write:0}}},parts:[]}]})};
    };
    const result=await probeTransportObservation({executable:'fake-opencode',
      outputDir,processRunner});
    assert.equal(result.state,'TRANSPORT_PROBE_PASS');
    assert.equal(result.requestCount,1);
    assert.deepEqual(calls,['--version','debug','run','export']);
    const saved=await readFile(resolve(outputDir,
      'arm/evidence/transport.json'),'utf8');
    const row=JSON.parse(saved).records[0];
    assert.equal(row.requestShape.format,'json-object');
    assert.equal(row.requestShape.messageCount,1);
    assert.ok(row.requestShape.messageBytes>0);
    assert.doesNotMatch(saved,/fake only|fake-key/u);
    assert.match(saved,/"prompt_tokens": 17/u);
  }finally{await rm(parent,{recursive:true,force:true});}
});
