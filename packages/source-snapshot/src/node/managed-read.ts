import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import { SourceSnapshotError } from '../errors.js';
import { readBoundedBytes } from './read-bounded.js';
import type { ReadByteLimit } from './read-bounded.js';
const code=(value:unknown):string|undefined=>value instanceof Error&&'code'in value&&typeof value.code==='string'?value.code:undefined;
export const readManagedBytes = async (root:string,logicalPath:string,required=true,limit?:ReadByteLimit):Promise<Uint8Array|undefined> => {
  const resolvedRoot=resolve(root); const target=resolvePathWithinRoot(resolvedRoot,logicalPath); let current=resolvedRoot;
  try{const rootStat=await lstat(resolvedRoot); if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new SourceSnapshotError('MANAGED_PATH_UNSAFE',{path:logicalPath});
    for(const segment of logicalPath.split('/')){current=join(current,segment); const metadata=await lstat(current); if(metadata.isSymbolicLink())throw new SourceSnapshotError('MANAGED_PATH_UNSAFE',{path:logicalPath}); if(current!==target&&!metadata.isDirectory())throw new SourceSnapshotError('MANAGED_PATH_UNSAFE',{path:logicalPath}); if(current===target&&!metadata.isFile())throw new SourceSnapshotError('MANAGED_PATH_UNSAFE',{path:logicalPath});}
    return limit === undefined ? new Uint8Array(await readFile(target)) : await readBoundedBytes(target, logicalPath, limit);
  }catch(error){if(code(error)==='ENOENT'){if(required)throw new SourceSnapshotError('SNAPSHOT_MISSING',{path:logicalPath});return undefined;} throw error;}
};
export const readManagedText = async (root:string,path:string,required=true):Promise<string|undefined> => {const bytes=await readManagedBytes(root,path,required);return bytes===undefined?undefined:new TextDecoder('utf-8',{fatal:true}).decode(bytes);};
