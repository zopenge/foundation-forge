import { once } from 'node:events';

// HTTP(S) 的禁用端口来自 https://fetch.spec.whatwg.org/#port-blocking。
const blockedPorts=new Set([
  0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,
  101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,
  389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,
  601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,
  6000,6566,6665,6666,6667,6668,6669,6679,6697,10080,
]);
const closeListener=server=>new Promise((resolveClose,reject)=>{
  server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'
    ?reject(error):resolveClose());
});

export const listenForFetch=async server=>{
  for(let attempt=0;attempt<32;attempt++){
    try{
      server.listen(0,'127.0.0.1');
      await once(server,'listening');
    }catch(error){
      try{await closeListener(server);}
      catch(closeError){throw Object.assign(new AggregateError([error,closeError],
        'TRANSPORT_LISTEN_FAILED',{cause:closeError}),{code:'TRANSPORT_LISTEN_FAILED'});}
      throw error;
    }
    const port=server.address().port;
    if(!blockedPorts.has(port))return port;
    // 先确认旧监听关闭，再申请新的系统端口；不重试请求、转发或验收。
    await closeListener(server);
  }
  throw Object.assign(new Error('TRANSPORT_FETCH_PORT_UNAVAILABLE'),
    {code:'TRANSPORT_FETCH_PORT_UNAVAILABLE'});
};
