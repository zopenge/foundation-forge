import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { startTransportObserver } from '../ab-eval/transport-observer.mjs';

const listen=async server=>{
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close=server=>new Promise((resolvePromise,reject)=>{
  server.closeIdleConnections();
  server.close(error=>error?reject(error):resolvePromise());
});
const sha=body=>createHash('sha256').update(body).digest('hex').toUpperCase();

test('transport observer forwards streaming requests and records only numeric usage',async()=>{
  const payload={model:'test',messages:[{role:'user',
    content:'private prompt text'}],tools:[{type:'function',
    function:{name:'private-tool',parameters:{type:'object'}}}]};
  const body=JSON.stringify(payload);
  const firstEvent='data: {"choices":[{"delta":{"content":"private answer"}}]}\n\n';
  const usageEvent='data: {"usage":{"prompt_tokens":123,"completion_tokens":7,"total_tokens":130,"prompt_tokens_details":{"cached_tokens":64}}}\n\ndata: [DONE]\n\n';
  let received=null;
  const upstream=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    received={url:req.url,auth:req.headers.authorization,
      contentEncoding:req.headers['content-encoding'],
      body:Buffer.concat(chunks).toString('utf8')};
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(firstEvent);
    res.end(usageEvent);
  });
  const upstreamURL=await listen(upstream);
  const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
  try{
    const response=await globalThis.fetch(`${observer.baseURL}/chat/completions`,{
      method:'POST',headers:{authorization:'Bearer fake-secret',
        'content-encoding':'gzip',
        'content-type':'application/json'},body});
    assert.equal(response.status,200);
    assert.match(await response.text(),/private answer/u);
    assert.deepEqual(received,{url:'/v1/chat/completions',
      auth:'Bearer fake-secret',contentEncoding:'gzip',body});
    const records=await observer.close();
    const messageBytes=Buffer.byteLength(JSON.stringify(payload.messages));
    const toolBytes=Buffer.byteLength(JSON.stringify(payload.tools));
    assert.equal(records.length,1);
    assert.match(records[0].startedAt,/^\d{4}-\d\d-\d\dT/u);
    assert.ok(records[0].durationMs>=0);
    assert.ok(records[0].responseHeaderMs>=0);
    assert.deepEqual({...records[0],startedAt:null,durationMs:null,
      responseHeaderMs:null},{index:1,startedAt:null,durationMs:null,
      responseHeaderMs:null,terminalEvent:'COMPLETED',cancelSource:null,
      errorClass:null,requestBytes:Buffer.byteLength(body),
      requestSha256:sha(body),requestShape:{format:'json-object',
        topLevelFieldCount:3,messageCount:1,messageBytes,
        messageItemBytes:[Buffer.byteLength(JSON.stringify(payload.messages[0]))],
        toolCount:1,toolBytes,
        toolItemBytes:[Buffer.byteLength(JSON.stringify(payload.tools[0]))],
        otherBytes:Buffer.byteLength(body)-messageBytes-toolBytes,
        itemSizesTruncated:false},responseStatus:200,
      responseBytes:Buffer.byteLength(firstEvent+usageEvent),
      usage:{prompt_tokens:123,completion_tokens:7,total_tokens:130,
        prompt_tokens_details:{cached_tokens:64}},errorCode:null});
    assert.doesNotMatch(JSON.stringify(records),
      /private prompt|private answer|private-tool|fake-secret/u);
  }finally{await observer.close();await close(upstream);}
});

test('transport observer records HTTP 502 without treating it as a connection error',async()=>{
  const upstream=createServer((req,res)=>{
    res.writeHead(502,{'content-type':'application/json'});
    res.end('{"error":"private upstream body"}');
  });
  const upstreamURL=await listen(upstream);
  const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
  try{
    const response=await globalThis.fetch(`${observer.baseURL}/chat/completions`,{
      method:'POST',body:'{}'});
    assert.equal(response.status,502);
    assert.equal(await response.text(),'{"error":"private upstream body"}');
    const [row]=await observer.close();
    assert.equal(row.terminalEvent,'UPSTREAM_HTTP_ERROR');
    assert.equal(row.responseStatus,502);
    assert.equal(row.errorCode,null);
    assert.doesNotMatch(JSON.stringify(row),/private upstream body/u);
  }finally{await observer.close();await close(upstream);}
});

test('transport observer preserves two same-body response sequences for diagnosis',async()=>{
  let call=0;
  const upstream=createServer(async(req,res)=>{
    for await(const chunk of req)void chunk;
    call+=1;
    res.setHeader('content-type','application/json');
    if(call===1){res.writeHead(502);res.end('{"error":"private error"}');return;}
    const usage=call===2?{prompt_tokens:10,completion_tokens:1}
      :call===3?{prompt_tokens:12,completion_tokens:0}
        :{prompt_tokens:13,completion_tokens:2};
    res.end(JSON.stringify({usage}));
  });
  const upstreamURL=await listen(upstream);
  const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
  try{
    for(const body of ['{"case":1}','{"case":1}',
      '{"case":2}','{"case":2}']){
      const response=await globalThis.fetch(`${observer.baseURL}/chat/completions`,{
        method:'POST',body});
      await response.text();
    }
    const records=await observer.close();
    assert.deepEqual(records.map(row=>row.responseStatus),[502,200,200,200]);
    assert.deepEqual(records.map(row=>row.usage?.completion_tokens??null),
      [null,1,0,2]);
    assert.equal(records[0].requestSha256,records[1].requestSha256);
    assert.equal(records[2].requestSha256,records[3].requestSha256);
    assert.notEqual(records[0].requestSha256,records[2].requestSha256);
    assert.doesNotMatch(JSON.stringify(records),/private error/u);
  }finally{await observer.close();await close(upstream);}
});

test('transport observer records safe SSE error evidence without changing bytes',async t=>{
  const cases=[
    ['JSON error','data: {"error":{"type":"server_error","message":"private SSE error"}}\r\n\r\n',true],
    ['named error','event: error\ndata: private named error\n\n',true],
    ['multiline error','data: {"error":\ndata: {"message":"private multiline error"}}\n\n',true],
    ['normal text','data: {"choices":[{"delta":{"content":"private error text"}}],"error":null}\n\n',false],
    ['malformed JSON','data: {"error": private invalid JSON\n\n',false],
    ['empty named event','event: error\n\ndata: {"choices":["private text"]}\n\n',false],
    ['oversized event','data: {"error":{"message":"private '
      +'x'.repeat(65536)+'"}}\n\n',false],
  ];
  for(const [name,event,isError] of cases)await t.test(name,async()=>{
    const body=Buffer.from('data: {"usage":{"prompt_tokens":13,"completion_tokens":0}}\n\n'
      +event+'data: [DONE]\n\n');
    const upstream=createServer((req,res)=>{
      res.writeHead(200,{'content-type':'text/event-stream'});
      const split=body.indexOf('private')+3;
      res.write(body.subarray(0,split));
      globalThis.setImmediate(()=>res.end(body.subarray(split)));
    });
    const upstreamURL=await listen(upstream);
    const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
    try{
      const response=await globalThis.fetch(`${observer.baseURL}/chat/completions`,{
        method:'POST',body:'{}'});
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
      const [row]=await observer.close();
      assert.equal(row.responseStatus,200);
      assert.equal(row.responseBytes,body.length);
      assert.equal(row.sseErrorCode??null,isError?'UPSTREAM_SSE_ERROR':null);
      assert.equal(row.terminalEvent,isError?'UPSTREAM_SSE_ERROR':'COMPLETED');
      assert.equal(row.errorCode,null);
      assert.deepEqual(row.usage,{prompt_tokens:13,completion_tokens:0});
      assert.doesNotMatch(JSON.stringify(row),/private|server_error/u);
    }finally{await observer.close();await close(upstream);}
  });
});

test('transport observer classifies a failed upstream connection safely',async()=>{
  const upstream=createServer();
  const upstreamURL=await listen(upstream);
  await close(upstream);
  const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
  try{
    const response=await globalThis.fetch(`${observer.baseURL}/chat/completions`,{
      method:'POST',body:'{}'});
    assert.equal(response.status,502);
    const [row]=await observer.close();
    assert.equal(row.terminalEvent,'UPSTREAM_CONNECTION_ERROR');
    assert.equal(row.responseStatus,null);
    assert.equal(row.cancelSource,null);
    assert.equal(row.errorClass,'TypeError');
    assert.equal(row.errorCode,'UPSTREAM_TRANSPORT_FAILED');
    assert.doesNotMatch(JSON.stringify(row),/127\.0\.0\.1|connect|stack/u);
  }finally{await observer.close();}
});

test('transport observer separates an interrupted upstream stream from connect failure',async()=>{
  let interruptStream;
  const upstream=createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: {"usage":{"prompt_tokens":3}}\n\n');
    res.write('data: {"error":{"message":"private stream error"}}\n\n');
    interruptStream=()=>res.destroy();
  });
  const upstreamURL=await listen(upstream);
  const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
  try{
    const response=await globalThis.fetch(`${observer.baseURL}/chat/completions`,{
      method:'POST',body:'{}'});
    const reader=response.body.getReader();
    assert.equal((await reader.read()).done,false);
    interruptStream();
    await assert.rejects(async()=>{
      while(!(await reader.read()).done){ /* 排空已收到的片段，直到中断到达。 */ }
    });
    const [row]=await observer.close();
    assert.equal(row.terminalEvent,'UPSTREAM_STREAM_ERROR');
    assert.equal(row.sseErrorCode,'UPSTREAM_SSE_ERROR');
    assert.equal(row.responseStatus,200);
    assert.equal(row.cancelSource,null);
    assert.equal(row.errorClass,'TypeError');
  }finally{interruptStream?.();await observer.close();await close(upstream);}
});

test('transport observer attributes an aborted response to the downstream',
  {timeout:5000},async()=>{
    let upstreamClosed;
    const closed=new Promise(resolvePromise=>{upstreamClosed=resolvePromise;});
    const upstream=createServer((req,res)=>{
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: {"choices":[]}\n\n');
      res.once('close',upstreamClosed);
    });
    const upstreamURL=await listen(upstream);
    const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
    try{
      await new Promise((resolvePromise,reject)=>{
        const client=request(`${observer.baseURL}/chat/completions`,{
          method:'POST'},response=>{
          response.once('data',()=>{client.destroy();resolvePromise();});
        });
        client.once('error',reject);
        client.end('{}');
      });
      await closed;
      const [row]=await observer.close();
      assert.equal(row.terminalEvent,'DOWNSTREAM_CANCEL');
      assert.equal(row.cancelSource,'downstream');
      assert.equal(row.errorCode,null);
    }finally{await observer.close();upstream.closeAllConnections();await close(upstream);}
  });

test('transport observer close waits for an aborted request handler to settle',
  {timeout:5000},async()=>{
    const originalFetch=globalThis.fetch;
    let startFetch;
    const fetchStarted=new Promise(resolvePromise=>{startFetch=resolvePromise;});
    let releaseFetch;
    const heldFetch=new Promise(resolvePromise=>{releaseFetch=resolvePromise;});
    let abortSeen;
    const upstreamAborted=new Promise(resolvePromise=>{abortSeen=resolvePromise;});
    globalThis.fetch=async(_target,{signal})=>{
      signal.addEventListener('abort',abortSeen,{once:true});
      startFetch();
      return heldFetch;
    };
    const observer=await startTransportObserver({
      upstreamBaseURL:'https://example.com/v1'});
    let closing;
    try{
      const client=request(`${observer.baseURL}/chat/completions`,{
        method:'POST'});
      client.on('error',()=>{});
      client.end('{}');
      await fetchStarted;
      client.destroy();
      await upstreamAborted;
      closing=observer.close();
      const returnedEarly=await Promise.race([
        closing.then(()=>true),
        new Promise(resolvePromise=>globalThis.setTimeout(()=>
          resolvePromise(false),30)),
      ]);
      assert.equal(returnedEarly,false);
      releaseFetch(new globalThis.Response(null,{status:200}));
      const [row]=await closing;
      assert.equal(row.terminalEvent,'DOWNSTREAM_CANCEL');
      assert.ok(row.durationMs>=0);
    }finally{
      releaseFetch(new globalThis.Response(null,{status:200}));
      await (closing??observer.close());
      globalThis.fetch=originalFetch;
    }
  });

test('transport observer close cancels a live upstream response stream',
  {timeout:5000},async()=>{
    const upstream=createServer((req,res)=>{
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: {"choices":[]}\n\n');
    });
    const upstreamURL=await listen(upstream);
    const observer=await startTransportObserver({
      upstreamBaseURL:`${upstreamURL}/v1`});
    let closing;
    try{
      const response=await globalThis.fetch(`${observer.baseURL}/chat/completions`,{
        method:'POST',body:'{}'});
      await response.body.getReader().read();
      closing=observer.close();
      const settled=await Promise.race([closing.then(()=>true),
        new Promise(resolvePromise=>globalThis.setTimeout(()=>
          resolvePromise(false),500))]);
      assert.equal(settled,true);
      const [row]=await closing;
      assert.equal(row.terminalEvent,'OBSERVER_CANCEL');
      assert.equal(row.cancelSource,'observer');
      assert.equal(row.responseStatus,200);
    }finally{
      upstream.closeAllConnections();
      await (closing??observer.close());
      await close(upstream);
    }
  });

test('transport observer preserves observer cancellation when a response arrives late',
  {timeout:5000},async()=>{
    const originalFetch=globalThis.fetch;
    let startFetch;
    const fetchStarted=new Promise(resolvePromise=>{startFetch=resolvePromise;});
    let releaseFetch;
    const heldFetch=new Promise(resolvePromise=>{releaseFetch=resolvePromise;});
    globalThis.fetch=async()=>{startFetch();return heldFetch;};
    const observer=await startTransportObserver({
      upstreamBaseURL:'https://example.com/v1'});
    let closing;
    try{
      const client=request(`${observer.baseURL}/chat/completions`,{method:'POST'});
      client.on('error',()=>{});
      client.end('{}');
      await fetchStarted;
      closing=observer.close();
      releaseFetch(new globalThis.Response(null,{status:200}));
      const [row]=await closing;
      assert.equal(row.terminalEvent,'OBSERVER_CANCEL');
      assert.equal(row.cancelSource,'observer');
      assert.equal(row.errorCode,null);
    }finally{
      releaseFetch(new globalThis.Response(null,{status:200}));
      await (closing??observer.close());
      globalThis.fetch=originalFetch;
    }
  });

test('transport observer rejects paths outside the configured base',async()=>{
  let calls=0;
  const upstream=createServer((req,res)=>{calls+=1;res.end('unexpected');});
  const upstreamURL=await listen(upstream);
  const observer=await startTransportObserver({upstreamBaseURL:`${upstreamURL}/v1`});
  try{
    const response=await globalThis.fetch(`http://127.0.0.1:${new URL(observer.baseURL).port}/other`,{
      method:'POST',body:'secret'});
    assert.equal(response.status,404);
    assert.equal(calls,0);
    assert.deepEqual(await observer.close(),[]);
  }finally{await observer.close();await close(upstream);}
});
