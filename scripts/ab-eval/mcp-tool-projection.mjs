const fail=code=>Object.assign(new Error(code),{code});

export const projectMcpBridge=({bridge,allowedNames})=>{
  if(typeof bridge?.handle!=='function'||!Array.isArray(allowedNames)
    ||allowedNames.length===0||allowedNames.some(name=>
      typeof name!=='string'||name.length===0)
    ||new Set(allowedNames).size!==allowedNames.length)
    throw fail('MCP_TOOL_PROJECTION_INVALID');
  const allowed=new Set(allowedNames);
  return {async handle(message){
    if(message?.method==='tools/call'&&!allowed.has(message.params?.name))
      return {jsonrpc:'2.0',id:message.id??null,result:{
        content:[{type:'text',text:JSON.stringify({code:'TOOL_NOT_ALLOWED'})}],
        isError:true}};
    const response=await bridge.handle(message);
    if(message?.method!=='tools/list')return response;
    if(!Array.isArray(response?.result?.tools))
      throw fail('MCP_TOOL_PROJECTION_LIST_INVALID');
    return {...response,result:{...response.result,
      tools:response.result.tools.filter(tool=>allowed.has(tool.name))}};
  }};
};
