import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { freezePack } from '../ab-eval/manifest.mjs';
import { executeEvaluation, prepareEvaluation,
  verifyEvaluationConnections } from '../ab-eval/workflow.mjs';
import { makeTarballFixture } from './ab-eval-tarball-fixture.mjs';

const tempRoot=resolve(import.meta.dirname,'../../.tmp');
const sha=value=>createHash('sha256').update(value).digest('hex').toUpperCase();
const schema={type:'object',additionalProperties:false,
  required:['query'],properties:{query:{type:'string'}}};
const changedSchema={type:'object',additionalProperties:false,
  required:['query'],properties:{query:{type:'number'}}};
const expectedSchemaSha256=sha('{"additionalProperties":false,'
  +'"properties":{"query":{"type":"string"}},"required":["query"],"type":"object"}');
const tool=(name,inputSchema=schema)=>({name,description:'Test tool',inputSchema});
const writeJson=(path,value)=>writeFile(path,`${JSON.stringify(value)}\n`);

const withPack=async({server='repository.context',pages,declared=['investigate','read','continue'],
  allowed=declared.map(name=>`repository_context_${name}`),schemas={},
  permissionOverride},fn)=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'r48-01-contract-'));
  try{
    const pack=resolve(root,'pack');
    await mkdir(resolve(pack,'fixture'),{recursive:true});
    await writeFile(resolve(pack,'fixture/source.txt'),'before\n');
    await writeFile(resolve(pack,'candidate.tgz'),makeTarballFixture());
    await writeFile(resolve(pack,'verify.mjs'),'process.exit(0);\n');
    await writeJson(resolve(pack,'pages.json'),pages);
    await writeFile(resolve(pack,'mcp.mjs'),`import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
const pages=JSON.parse(readFileSync(new URL('./pages.json',import.meta.url),'utf8'));
if(pages===null)process.exit(7);
for await(const line of createInterface({input:process.stdin})){
  const item=JSON.parse(line);
  if(item.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:item.id,
    result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},
      serverInfo:{name:'fixture',version:'1'}}})+'\\n');
  if(item.method==='tools/list'){
    const cursor=item.params?.cursor;
    const page=cursor===undefined?pages.first:pages[cursor];
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:item.id,result:page})+'\\n');
  }
}
`);
    const names=allowed;
    const permission=permissionOverride??Object.fromEntries([
      ['*','deny'],...names.map(name=>[name,'allow'])]);
    await writeJson(resolve(pack,'a.json'),{permission:{'*':'deny',read:'allow'}});
    await writeJson(resolve(pack,'c.json'),{permission,mcp:{[server]:{
      type:'local',enabled:true,timeout:30000,
      command:['{{NODE}}','{{PACK_DIR}}/mcp.mjs']}}});
    const draft={schemaVersion:1,id:'r48-01-fixture',candidate:'candidate.tgz',
      client:{kind:'opencode',version:'1.18.30',model:'vendor/model',
        variant:'high',agent:'build'},configs:{A:'a.json',C:'c.json'},
      tasks:[{id:'task',fixture:'fixture',prompt:'Fix task.',
        publicVerifier:'verify.mjs',hiddenVerifier:'verify.mjs'}],
      pairs:[{id:'pair-1',taskId:'task',order:'AC'}],concurrency:1,
      armTimeoutMs:600000,allowedTools:{A:['read'],C:allowed},
      toolContract:{A:{native:['read'],mcp:{}},C:{native:[],mcp:{
        [server]:Object.fromEntries(declared.map(name=>[
          name,schemas[name]??expectedSchemaSha256]))}}}};
    await writeJson(resolve(pack,'draft.json'),draft);
    await freezePack({draftPath:resolve(pack,'draft.json'),
      outputPath:resolve(pack,'pack.json')});
    const client=resolve(root,'opencode.exe');
    const auth=resolve(root,'auth.json');
    await writeFile(client,'fake-client');
    await writeFile(auth,'{"token":"test-only"}');
    const calls=[];
    const processRunner=async spec=>{
      calls.push(spec.args[0]);
      if(spec.args[0]==='--version')return {status:0,stdout:'1.18.30\n'};
      if(spec.args[0]==='mcp')return {status:0,stdout:`${server} connected\n`};
      throw new Error(`MODEL_CALL_FORBIDDEN:${spec.args[0]}`);
    };
    const runDir=resolve(root,'run');
    const preflight=await prepareEvaluation({manifestPath:resolve(pack,'pack.json'),
      runDir,clientExecutable:client,authPath:auth,processRunner});
    await fn({root,runDir,preflight,processRunner,calls});
  }finally{await rm(root,{recursive:true,force:true});}
};

const fullPages={first:{tools:[tool('investigate'),tool('read'),tool('continue')]}};

test('doctor accepts a separately declared three-tool C navigation contract',()=>withPack(
  {pages:fullPages},async({runDir,processRunner,calls})=>{
    const result=await verifyEvaluationConnections({runDir,processRunner});
    assert.equal(result.state,'MODEL_DISABLED_CONNECTED',JSON.stringify(result.rows));
    assert.equal(result.toolContractValidatedArms,2);
    assert.equal(result.modelCalls,0);
    assert.deepEqual(calls,['--version','mcp']);
  }));

for(const [name,pages,code] of [
  ['missing tool',{first:{tools:[tool('investigate'),tool('read')]}},
    'TOOL_CONTRACT_TOOL_SET_MISMATCH'],
  ['extra tool',{first:{tools:[tool('investigate'),tool('read'),
    tool('continue'),tool('unexpected')]}},'TOOL_CONTRACT_TOOL_SET_MISMATCH'],
  ['schema drift',{first:{tools:[tool('investigate'),tool('read'),
    tool('continue',changedSchema)]}},'TOOL_CONTRACT_SCHEMA_DRIFT'],
])test(`doctor blocks ${name} before a model call`,()=>withPack({pages},
  async({runDir,processRunner,calls})=>{
    const result=await verifyEvaluationConnections({runDir,processRunner});
    assert.equal(result.state,'TOOL_CONTRACT_FAILED');
    assert.equal(result.rows.find(row=>row.arm==='C').contractError,code);
    assert.equal(result.modelCalls,0);
    assert.equal(calls.includes('run'),false);
  }));

test('doctor consumes all tools/list pages before accepting the contract',()=>withPack({
  pages:{first:{tools:[tool('investigate')],nextCursor:'next'},
    next:{tools:[tool('read'),tool('continue')]}},
},async({runDir,processRunner})=>{
  const result=await verifyEvaluationConnections({runDir,processRunner});
  assert.equal(result.state,'MODEL_DISABLED_CONNECTED',JSON.stringify(result.rows));
  assert.equal(result.rows.find(row=>row.arm==='C').tools.length,3);
}));

test('doctor blocks repeated tools/list cursor instead of accepting a partial list',
  ()=>withPack({pages:{first:{tools:[tool('investigate')],nextCursor:'next'},
    next:{tools:[tool('read')],nextCursor:'next'}}},
  async({runDir,processRunner})=>{
    const result=await verifyEvaluationConnections({runDir,processRunner});
    assert.equal(result.state,'TOOL_CONTRACT_FAILED');
    assert.equal(result.rows.find(row=>row.arm==='C').contractError,
      'MCP_TOOL_PROBE_CURSOR_INVALID');
  }));

test('doctor rejects an extra tool that collides after namespace mapping',()=>withPack({
  declared:['a.b'],allowed:['repository_context_a_b'],
  pages:{first:{tools:[tool('a.b'),tool('a_b')]}}},
async({runDir,processRunner,calls})=>{
  const result=await verifyEvaluationConnections({runDir,processRunner});
  assert.equal(result.state,'TOOL_CONTRACT_FAILED');
  assert.equal(result.rows.find(row=>row.arm==='C').contractError,
    'TOOL_CONTRACT_TOOL_SET_MISMATCH');
  assert.equal(calls.includes('run'),false);
}));

test('freeze rejects two names that map to the same model tool',async()=>{
  await assert.rejects(()=>withPack({declared:['a.b','a_b'],
    allowed:['repository_context_a_b'],
    pages:{first:{tools:[tool('a.b'),tool('a_b')]}},
  },async()=>{}),{code:'PACK_TOOL_NAME_COLLISION'});
});

test('freeze rejects an allowed set that omits declared continue',async()=>{
  await assert.rejects(()=>withPack({
    allowed:['repository_context_investigate','repository_context_read'],
    pages:fullPages},async()=>{}),{code:'PACK_TOOL_ALLOWLIST_MISMATCH'});
});

test('doctor rejects an extra permission grant outside the frozen allowlist',
  ()=>withPack({pages:fullPages,permissionOverride:{'*':'deny',
    repository_context_investigate:'allow',repository_context_read:'allow',
    repository_context_continue:'allow',unexpected:'allow'}},
  async({runDir,processRunner})=>{
    const result=await verifyEvaluationConnections({runDir,processRunner});
    assert.equal(result.state,'TOOL_CONTRACT_FAILED');
    assert.equal(result.rows.find(row=>row.arm==='C').contractError,
      'TOOL_CONTRACT_PERMISSION_MISMATCH');
  }));

test('doctor fails closed when the MCP process exits before initialize',
  ()=>withPack({pages:null},async({runDir,processRunner,calls})=>{
    const result=await verifyEvaluationConnections({runDir,processRunner});
    assert.equal(result.state,'TOOL_CONTRACT_FAILED');
    assert.equal(result.modelCalls,0);
    assert.equal(calls.includes('run'),false);
  }));

test('run refuses a legacy connection receipt before creating a lock or model call',
  ()=>withPack({pages:fullPages},async({runDir,preflight,processRunner,calls})=>{
    await writeJson(resolve(runDir,'approval.json'),{approved:true,
      runId:preflight.runId,manifestSha256:preflight.manifestSha256,
      approvedArmIds:['pair-1-A','pair-1-C'],userAuthorization:'test-only'});
    await writeJson(resolve(runDir,'connection-preflight.json'),{
      state:'MODEL_DISABLED_CONNECTED',runId:preflight.runId,cArms:1,cConnected:1,
      preflightSha256:sha(await readFile(resolve(runDir,'preflight.json'))),
      modelCalls:0});
    await assert.rejects(()=>executeEvaluation({runDir,processRunner}),
      {code:'CONNECTION_PREFLIGHT_INVALID'});
    await assert.rejects(()=>readFile(resolve(runDir,'run.lock.json')),
      {code:'ENOENT'});
    assert.equal(calls.includes('run'),false);
  }));
