import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

// 对既有闪窗缺口的实际调用表达式注入替身；不执行 fixture 顶层或任何 OS 子进程。
const paths = [
  "packages/release-vercel/tests/cli.test.ts",
  "packages/release-vercel/tests/managed-release.test.ts",
  "packages/release-vercel/tests/source-managed.test.ts",
  "packages/repository-files/package-consumer/verify.mjs",
  "packages/source-snapshot/package-consumer/verify.mjs",
  "packages/source-snapshot/package-consumer/node-v2.mjs",
  "packages/source-snapshot/package-consumer/reading-v3.mjs",
  "packages/text-integrity/package-consumer/verify.mjs",
  "packages/workspace-checks-pnpm/package-consumer/verify.mjs",
  "packages/repository-policy/package-consumer/verify.mjs"
];
const expressionAt = function expressionAt(source, start){
 let depth=0, quote, escaped=false, opened=false;
 for(let i=start;i<source.length;i++){
  const c=source[i];
  if(quote){if(escaped){escaped=false;continue;}if(c==="\\"){escaped=true;continue;}if(c===quote)quote=undefined;continue;}
  if(c==="'"||c==='"'||c==="`"){quote=c;continue;}
  if(c==="("){depth++;opened=true;}
  else if(c===")"){depth--;if(opened&&depth===0)return source.slice(start,i+1);}
 }
 throw new Error("unbalanced selected invocation");
};
const evaluateCalls = (sources)=>{
 const results=[];
 for(const [path,source] of Object.entries(sources)){
  for(const match of source.matchAll(/\b(spawnSync|execFileSync)\(/g)){
   const expression=expressionAt(source,match.index);
   const captures=[];
   const record=(command,args,options)=>{captures.push({command,args,options});return "fake-sha";};
   const env={spawnSync:record,execFileSync:record,process:{execPath:"C:/node.exe",cwd:()=>"/fixture",platform:"win32",env:{}},args:["a","b"],input:"stdin",cli:"cli.js",source:"/source",sourceRoot:"/source",fixture:"/fixture",binary:"bin.js",binaries:{"forge-text-integrity":"text.js","forge-workspace-checks":"workspace.js"},cycle:"/cycle",target:"/target",base:"/base",bin:"bin.js",config:"config.json",linkedBinDirectory:"/linked",join:(...x)=>x.join("/"),snapshotId:"snapshot",unpackRoot:"/unpacked",f:{cwd:"/fixture"},mode:"100644",oid:"a".repeat(40),Buffer:{from:(...x)=>({from:x}),concat:x=>({concat:x})}};
   new Function(...Object.keys(env),`return (${expression});`)(...Object.values(env));
   if(captures.length!==1)throw new Error("unexpected call count");
   results.push({path,line:source.slice(0,match.index).split("\n").length,expression,hidden:captures[0].options?.windowsHide===true,observed:captures[0]});
  }
 }
 return results;
};

test('已确认验收启动点保留隐藏参数，参数检查不调用真实 spawn', async () => {
  const sources = Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, await readFile(resolve(import.meta.dirname, '../..', path), 'utf8')])));
  const results = evaluateCalls(sources);
  assert.equal(results.length, 26);
  for (const result of results) assert.equal(result.hidden, true, result.path + ':' + result.line);
});
