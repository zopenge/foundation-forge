import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const fail=code=>Object.assign(new Error(code),{code});
const inside=(base,path)=>path===base||path.startsWith(base+sep);
const references=source=>{
  const result=[];
  for(const expression of [
    /\bfrom\s*['"](\.[^'"]+)['"]/gu,
    /\bimport\s*['"](\.[^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu,
    /\bnew\s+URL\s*\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
  ]){
    for(const match of source.matchAll(expression))result.push(match[1]);
  }
  return result;
};

export const collectRelativeModuleClosure=async({root,seeds})=>{
  const base=await realpath(root);
  const pending=[...seeds];
  const visited=new Set();
  while(pending.length>0){
    const item=pending.pop();
    const absolute=resolve(base,item);
    if(!inside(base,absolute))throw fail('MODULE_PATH_OUTSIDE_ROOT');
    const actual=await realpath(absolute);
    if(!inside(base,actual))throw fail('MODULE_PATH_OUTSIDE_ROOT');
    const rel=relative(base,actual).replaceAll('\\','/');
    if(visited.has(rel))continue;
    visited.add(rel);
    const source=await readFile(actual,'utf8');
    for(const reference of references(source))pending.push(resolve(actual,'..',reference));
  }
  return [...visited].sort();
};
