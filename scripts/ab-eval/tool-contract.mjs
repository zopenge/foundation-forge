import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const fail=code=>Object.assign(new Error(code),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sanitize=value=>value.replace(/[^a-zA-Z0-9_-]/gu,'_');
const sorted=value=>Array.isArray(value)?value.map(sorted):record(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());

export const schemaSha256=schema=>sha(JSON.stringify(sorted(schema)));

export const validateToolContractShape=manifest=>{
  if(manifest.toolContract===undefined)return;
  if(!record(manifest.toolContract)
    ||!same(Object.keys(manifest.toolContract),['A','C']))
    throw fail('PACK_TOOL_CONTRACT_INVALID');
  for(const arm of ['A','C']){
    const contract=manifest.toolContract[arm];
    if(!record(contract)||!Array.isArray(contract.native)
      ||!record(contract.mcp)||contract.native.some(name=>
        typeof name!=='string'||name.length===0)
      ||new Set(contract.native).size!==contract.native.length)
      throw fail('PACK_TOOL_CONTRACT_INVALID');
    const names=[...contract.native];
    for(const [server,tools] of Object.entries(contract.mcp)){
      if(!server||!record(tools)||Object.keys(tools).length===0)
        throw fail('PACK_TOOL_CONTRACT_INVALID');
      for(const [name,digest] of Object.entries(tools)){
        if(!name||!/^[A-F0-9]{64}$/u.test(digest))
          throw fail('PACK_TOOL_CONTRACT_INVALID');
        names.push(`${sanitize(server)}_${sanitize(name)}`);
      }
    }
    if(new Set(names).size!==names.length)
      throw fail('PACK_TOOL_NAME_COLLISION');
    if(!same(names,manifest.allowedTools[arm]))
      throw fail('PACK_TOOL_ALLOWLIST_MISMATCH');
  }
};

export const assertToolContract=({contract,allowedTools,config,toolSets})=>{
  const mcp=config?.mcp??{};
  if(!record(contract)||!record(config)||!record(mcp)
    ||!record(config.permission)||Object.keys(config.permission)[0]!=='*'
    ||config.permission['*']!=='deny'
    ||!same(Object.keys(mcp),Object.keys(contract.mcp)))
    throw fail('TOOL_CONTRACT_CONFIG_INVALID');
  const expected=[...contract.native];
  const seen=new Set(expected);
  for(const [server,definitions] of Object.entries(contract.mcp)){
    if(mcp[server]?.type!=='local'||mcp[server]?.enabled!==true)
      throw fail('TOOL_CONTRACT_CONFIG_INVALID');
    const listed=toolSets[server];
    if(!Array.isArray(listed)||!same(listed.map(item=>item.name),
      Object.keys(definitions)))throw fail('TOOL_CONTRACT_TOOL_SET_MISMATCH');
    for(const item of listed){
      if(typeof item.name!=='string'||!record(item.inputSchema)
        ||schemaSha256(item.inputSchema)!==definitions[item.name])
        throw fail('TOOL_CONTRACT_SCHEMA_DRIFT');
      const mapped=`${sanitize(server)}_${sanitize(item.name)}`;
      if(seen.has(mapped))throw fail('TOOL_CONTRACT_NAME_COLLISION');
      seen.add(mapped);
      expected.push(mapped);
    }
  }
  if(!same(expected,allowedTools))throw fail('TOOL_CONTRACT_ALLOWLIST_MISMATCH');
  for(const name of allowedTools){
    if(config.permission[name]!=='allow')
      throw fail('TOOL_CONTRACT_PERMISSION_MISMATCH');
  }
  for(const [name,value] of Object.entries(config.permission)){
    if(name!=='*'&&value!=='deny'&&!allowedTools.includes(name))
      throw fail('TOOL_CONTRACT_PERMISSION_MISMATCH');
  }
  return expected.sort();
};

const stopOwned=child=>{
  if(child.exitCode!==null||child.signalCode!==null||child.pid===undefined)return;
  if(process.platform==='win32')spawnSync('taskkill',
    ['/PID',String(child.pid),'/T','/F'],
    {windowsHide:true,shell:false,timeout:5000,stdio:'ignore'});
  else child.kill('SIGKILL');
};

export const probeMcpTools=async({server,config,invocation,timeoutMs=30000})=>{
  if(config?.type!=='local'||!Array.isArray(config.command)
    ||config.command.length===0||config.command.some(x=>
      typeof x!=='string'||x.length===0)
    ||!record(config.environment??{}))throw fail('MCP_TOOL_PROBE_CONFIG_INVALID');
  const [executable,...args]=config.command;
  const cwd=config.cwd?resolve(invocation.cwd,config.cwd):invocation.cwd;
  const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,
    env:{...invocation.env,...config.environment},stdio:['pipe','pipe','pipe']});
  let buffer='';let pending=null;let failed=null;let outputBytes=0;
  const reject=error=>{
    failed=error;
    if(pending){pending.reject(error);pending=null;}
  };
  child.stdout.on('data',chunk=>{
    outputBytes+=chunk.length;
    if(outputBytes>1024*1024){reject(fail('MCP_TOOL_PROBE_OUTPUT_LIMIT'));stopOwned(child);return;}
    buffer+=chunk.toString('utf8');
    for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){
      const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
      if(!line)continue;
      let response;
      try{response=JSON.parse(line);}catch{reject(fail('MCP_TOOL_PROBE_PROTOCOL_INVALID'));return;}
      if(pending&&response.id===pending.id){
        const current=pending;pending=null;
        if(response.error||!record(response.result))
          current.reject(fail('MCP_TOOL_PROBE_PROTOCOL_INVALID'));
        else current.resolve(response.result);
      }
    }
  });
  child.stderr.on('data',chunk=>{
    outputBytes+=chunk.length;
    if(outputBytes>1024*1024){reject(fail('MCP_TOOL_PROBE_OUTPUT_LIMIT'));stopOwned(child);}
  });
  child.on('error',()=>reject(fail('MCP_TOOL_PROBE_PROCESS_FAILED')));
  child.on('close',()=>reject(fail('MCP_TOOL_PROBE_PROCESS_EXITED')));
  let id=0;
  const request=(method,params)=>new Promise((resolveResult,rejectResult)=>{
    if(failed){rejectResult(failed);return;}
    const next=++id;
    const timer=setTimeout(()=>{
      reject(fail('MCP_TOOL_PROBE_TIMEOUT'));stopOwned(child);
    },timeoutMs);
    pending={id:next,resolve:value=>{clearTimeout(timer);resolveResult(value);},
      reject:error=>{clearTimeout(timer);rejectResult(error);}};
    child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id:next,method,
      ...(params===undefined?{}:{params})})}\n`);
  });
  try{
    const initialized=await request('initialize',{protocolVersion:'2025-03-26',
      capabilities:{},clientInfo:{name:'foundation-forge-ab-eval',version:'1'}});
    if(!record(initialized.capabilities?.tools))
      throw fail('MCP_TOOL_PROBE_CAPABILITY_MISSING');
    child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',
      method:'notifications/initialized'})}\n`);
    const tools=[];const cursors=new Set();let cursor;
    for(let page=0;page<1000;page++){
      const result=await request('tools/list',cursor===undefined?undefined:{cursor});
      if(!Array.isArray(result.tools))throw fail('MCP_TOOL_PROBE_PROTOCOL_INVALID');
      tools.push(...result.tools);
      if(tools.length>1000)throw fail('MCP_TOOL_PROBE_TOOL_LIMIT');
      if(result.nextCursor===undefined)return {server,tools,pages:page+1};
      if(typeof result.nextCursor!=='string'||!result.nextCursor
        ||cursors.has(result.nextCursor))throw fail('MCP_TOOL_PROBE_CURSOR_INVALID');
      cursors.add(result.nextCursor);cursor=result.nextCursor;
    }
    throw fail('MCP_TOOL_PROBE_PAGE_LIMIT');
  }finally{
    child.stdin.end();
    stopOwned(child);
  }
};
