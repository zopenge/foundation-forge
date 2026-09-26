import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

const fail=code=>Object.assign(new Error(code),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const hopHeaders=new Set(['connection','content-length',
  'host','keep-alive','proxy-authenticate','proxy-authorization','te',
  'trailer','transfer-encoding','upgrade']);
const responseExcludedHeaders=new Set([...hopHeaders,'content-encoding']);
const allowedUsageFields=['prompt_tokens','completion_tokens','total_tokens',
  'input_tokens','output_tokens','prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens'];
const allowedDetailFields=['cached_tokens','cache_read_tokens',
  'cache_write_tokens','reasoning_tokens'];
const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const numericUsage=value=>{
  const source=value?.usage;
  if(!source||typeof source!=='object'||Array.isArray(source))return null;
  const usage={};
  for(const key of allowedUsageFields){
    const valueNumber=number(source[key]);
    if(valueNumber!==null)usage[key]=valueNumber;
  }
  for(const key of ['prompt_tokens_details','input_tokens_details',
    'completion_tokens_details','output_tokens_details']){
    const details=source[key];
    if(!details||typeof details!=='object'||Array.isArray(details))continue;
    const picked={};
    for(const field of allowedDetailFields){
      const valueNumber=number(details[field]);
      if(valueNumber!==null)picked[field]=valueNumber;
    }
    if(Object.keys(picked).length>0)usage[key]=picked;
  }
  return Object.keys(usage).length>0?usage:null;
};
const parsedUsage=text=>{
  try{return numericUsage(JSON.parse(text));}
  catch{return null;}
};
const observeSseErrors=row=>{
  let namedError=false;let data='';let hasData=false;let discarded=false;
  return line=>{
    if(line===null){data='';discarded=true;return;}
    if(line===''){
      if(!discarded&&hasData){
        let error=null;
        try{error=JSON.parse(data)?.error;}catch{ /* 非 JSON 事件仅按事件名分类。 */ }
        if(namedError||(typeof error==='string'&&error.length>0)
          ||(error!==null&&typeof error==='object'&&!Array.isArray(error)))
          row.sseErrorCode='UPSTREAM_SSE_ERROR';
      }
      namedError=false;data='';hasData=false;discarded=false;
      return;
    }
    if(discarded)return;
    if(line.startsWith('event:')){
      namedError=line.slice(6).replace(/^ /u,'')==='error';
    }else if(line.startsWith('data:')){
      const value=line.slice(5).replace(/^ /u,'');
      if(data.length+value.length+1>65536){data='';discarded=true;return;}
      data+=(hasData?'\n':'')+value;
      hasData=true;
    }
  };
};
const safeErrorClass=error=>new Set(['AbortError','TypeError','RangeError',
  'SyntaxError']).has(error?.name)?error.name:'Error';
const requestShape=bytes=>{
  let value;
  try{value=JSON.parse(bytes.toString('utf8'));}
  catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const messages=Array.isArray(value.messages)?value.messages:[];
  const tools=Array.isArray(value.tools)?value.tools:[];
  const serializedBytes=item=>Buffer.byteLength(JSON.stringify(item));
  const messageBytes=messages.length>0?serializedBytes(messages):0;
  const toolBytes=tools.length>0?serializedBytes(tools):0;
  const itemLimit=128;
  return {format:'json-object',
    topLevelFieldCount:Object.keys(value).length,
    messageCount:messages.length,messageBytes,
    messageItemBytes:messages.slice(0,itemLimit).map(serializedBytes),
    toolCount:tools.length,toolBytes,
    toolItemBytes:tools.slice(0,itemLimit).map(serializedBytes),
    otherBytes:serializedBytes(value)-messageBytes-toolBytes,
    itemSizesTruncated:messages.length>itemLimit||tools.length>itemLimit};
};
export const validateTransportBaseURL=value=>{
  let url;
  try{url=new URL(value);}catch{throw fail('TRANSPORT_UPSTREAM_INVALID');}
  const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&local))
    ||url.username||url.password||url.search||url.hash)
    throw fail('TRANSPORT_UPSTREAM_INVALID');
  return url;
};

export const startTransportObserver=async({upstreamBaseURL,
  maxRequestBytes=8*1024*1024}={})=>{
  const upstream=validateTransportBaseURL(upstreamBaseURL);
  if(!Number.isSafeInteger(maxRequestBytes)||maxRequestBytes<1)
    throw fail('TRANSPORT_REQUEST_LIMIT_INVALID');
  const basePath=upstream.pathname.replace(/\/$/u,'');
  const records=[];
  const events=[];
  const active=new Map();
  const handlerErrors=[];
  let nextIndex=0;
  const handleRequest=async(req,res,state)=>{
    const incoming=new URL(req.url,'http://127.0.0.1');
    if(incoming.pathname!==basePath
      &&!incoming.pathname.startsWith(`${basePath}/`)){
      res.writeHead(404);res.end();return;
    }
    const started=performance.now();
    const row={index:++nextIndex,startedAt:new Date().toISOString(),
      durationMs:null,responseHeaderMs:null,terminalEvent:null,
      cancelSource:null,errorClass:null,requestBytes:0,requestSha256:null,
      requestShape:null,
      responseStatus:null,responseBytes:0,usage:null,errorCode:null};
    records.push(row);
    const chunks=[];
    let phase='request';
    const noteDownstreamCancel=()=>{
      if(row.cancelSource||row.terminalEvent)return;
      row.cancelSource='downstream';
      row.terminalEvent='DOWNSTREAM_CANCEL';
      row.durationMs??=performance.now()-started;
    };
    state.cancelObserver=()=>{
      if(res.writableEnded||res.destroyed)return;
      if(!row.cancelSource){
        row.cancelSource='observer';
        row.terminalEvent='OBSERVER_CANCEL';
        row.durationMs??=performance.now()-started;
      }
      state.abort?.abort();
      res.destroy();
    };
    req.once('aborted',noteDownstreamCancel);
    try{
      for await(const chunk of req){
        row.requestBytes+=chunk.length;
        if(row.requestBytes>maxRequestBytes){
          row.errorCode='REQUEST_TOO_LARGE';
          row.terminalEvent='REQUEST_TOO_LARGE';
          res.writeHead(413);res.end();return;
        }
        chunks.push(chunk);
      }
      const body=Buffer.concat(chunks);
      row.requestSha256=sha(body);
      row.requestShape=requestShape(body);
      const target=new URL(upstream);
      target.pathname=incoming.pathname;
      target.search=incoming.search;
      const headers=new globalThis.Headers();
      for(const [key,value] of Object.entries(req.headers)){
        if(hopHeaders.has(key)||value===undefined)continue;
        headers.set(key,Array.isArray(value)?value.join(', '):value);
      }
      headers.set('accept-encoding','identity');
      const abort=new globalThis.AbortController();
      state.abort=abort;
      res.once('close',()=>{if(!res.writableEnded){
        noteDownstreamCancel();abort.abort();
      }});
      phase='connect';
      const upstreamResponse=await globalThis.fetch(target,{
        method:req.method,headers,body:body.length>0?body:undefined,
        redirect:'manual',signal:abort.signal});
      row.responseStatus=upstreamResponse.status;
      row.responseHeaderMs=performance.now()-started;
      phase='stream';
      const responseHeaders={};
      for(const [key,value] of upstreamResponse.headers){
        if(!responseExcludedHeaders.has(key))responseHeaders[key]=value;
      }
      res.writeHead(upstreamResponse.status,responseHeaders);
      const isEventStream=upstreamResponse.headers.get('content-type')
        ?.includes('text/event-stream')===true;
      const decoder=new TextDecoder();
      const observeError=observeSseErrors(row);
      let pending='';
      let jsonBody='';
      for await(const chunk of upstreamResponse.body??[]){
        row.responseBytes+=chunk.length;
        const decoded=decoder.decode(chunk,{stream:true});
        if(isEventStream){
          pending+=decoded;
          let newline=pending.indexOf('\n');
          while(newline!==-1){
            const line=pending.slice(0,newline).replace(/\r$/u,'');
            pending=pending.slice(newline+1);
            observeError(line);
            if(line.startsWith('data:')){
              const usage=parsedUsage(line.slice(5).trimStart());
              if(usage)row.usage=usage;
            }
            newline=pending.indexOf('\n');
          }
          if(pending.length>65536){pending='';observeError(null);}
        }else if(jsonBody.length<1048576)jsonBody+=decoded;
        if(!res.write(chunk))await once(res,'drain',{signal:abort.signal});
      }
      if(!isEventStream)row.usage=parsedUsage(jsonBody);
      res.end();
      if(!row.cancelSource)row.terminalEvent=
        upstreamResponse.status>=400?'UPSTREAM_HTTP_ERROR'
          :row.sseErrorCode??'COMPLETED';
    }catch(error){
      row.terminalEvent=row.cancelSource==='downstream'
        ?'DOWNSTREAM_CANCEL':row.cancelSource==='observer'
          ?'OBSERVER_CANCEL':phase==='connect'
          ?'UPSTREAM_CONNECTION_ERROR':phase==='stream'
            ?'UPSTREAM_STREAM_ERROR':'OBSERVER_ERROR';
      if(row.terminalEvent!=='DOWNSTREAM_CANCEL'
        &&row.terminalEvent!=='OBSERVER_CANCEL'){
        row.errorCode='UPSTREAM_TRANSPORT_FAILED';
        row.errorClass=safeErrorClass(error);
      }
      if(!res.destroyed){
        if(res.headersSent)res.destroy();
        else{res.writeHead(502);res.end();}
      }
    }finally{
      row.durationMs=performance.now()-started;
    }
  };
  const server=createServer((req,res)=>{
    const state={abort:null,cancelObserver:()=>res.destroy()};
    const work=handleRequest(req,res,state);
    active.set(work,state);
    work.then(()=>active.delete(work),error=>{
      active.delete(work);
      handlerErrors.push(error);
    });
  });
  server.listen(0,'127.0.0.1');
  try{await once(server,'listening');}
  catch(error){server.close();throw error;}
  const baseURL=`http://127.0.0.1:${server.address().port}${basePath}`;
  let closePromise=null;
  const close=()=>{
    if(!closePromise){
      events.push({type:'OBSERVER_CLOSING',at:new Date().toISOString()});
      closePromise=new Promise((resolvePromise,reject)=>{
        for(const state of active.values())state.cancelObserver();
        server.closeIdleConnections();
        server.close(async error=>{
          await Promise.allSettled([...active.keys()]);
          events.push({type:'OBSERVER_CLOSED',at:new Date().toISOString()});
          if(error)reject(error);
          else if(handlerErrors.length>0)
            reject(fail('TRANSPORT_OBSERVER_HANDLER_FAILED'));
          else resolvePromise(records);
        });
      });
    }
    return closePromise;
  };
  const recordArmTimeout=()=>events.push({type:'ARM_TIMEOUT',
    at:new Date().toISOString()});
  return {baseURL,close,events,recordArmTimeout};
};
