import assert from 'node:assert/strict';
import test from 'node:test';

import { projectMcpBridge } from '../ab-eval/mcp-tool-projection.mjs';

test('MCP projection exposes and calls only explicitly allowed tools',async()=>{
  const calls=[];
  const bridge={handle:async message=>{
    calls.push(message);
    if(message.method==='tools/list')return {jsonrpc:'2.0',id:message.id,
      result:{tools:[
        {name:'replace_text',inputSchema:{type:'object'}},
        {name:'run_public_test',inputSchema:{type:'object'}},
      ]}};
    return {jsonrpc:'2.0',id:message.id,result:{content:[],isError:false}};
  }};
  const projected=projectMcpBridge({bridge,allowedNames:['replace_text']});
  const listed=await projected.handle({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.deepEqual(listed.result.tools.map(tool=>tool.name),['replace_text']);
  const denied=await projected.handle({jsonrpc:'2.0',id:2,
    method:'tools/call',params:{name:'run_public_test',arguments:{}}});
  assert.equal(denied.result.isError,true);
  assert.equal(calls.length,1);
  const allowed=await projected.handle({jsonrpc:'2.0',id:3,
    method:'tools/call',params:{name:'replace_text',arguments:{}}});
  assert.equal(allowed.result.isError,false);
  assert.equal(calls.length,2);
});
