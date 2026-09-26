import { createInterface } from 'node:readline';

const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
  if(!line.trim())continue;
  let message;
  try{message=JSON.parse(line);}catch{continue;}
  if(message.id===undefined)continue;
  let result;
  if(message.method==='initialize')result={
    protocolVersion:message.params?.protocolVersion??'2025-03-26',
    capabilities:{tools:{listChanged:false}},
    serverInfo:{name:'ab-eval-client-probe',version:'1.0.0'},
  };
  else if(message.method==='tools/list')result={tools:[{
    name:'ab_probe',description:'Model-disabled connection probe.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
  }]};
  else if(message.method==='ping')result={};
  else if(message.method==='tools/call'&&message.params?.name==='ab_probe')
    result={content:[{type:'text',text:'ok'}]};
  const response=result===undefined
    ?{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}}
    :{jsonrpc:'2.0',id:message.id,result};
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
