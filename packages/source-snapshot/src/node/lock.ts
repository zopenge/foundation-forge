import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { SourceSnapshotError } from '../errors.js';
const code = (value: unknown): string | undefined => value instanceof Error && 'code' in value && typeof value.code==='string'?value.code:undefined;
const running = (pid: unknown): boolean => { if(!Number.isInteger(pid)||(pid as number)<=0)return false; try{process.kill(pid as number,0);return true;}catch{return false;} };
export const acquireSourceSnapshotLock = async (lockPath:string):Promise<()=>Promise<void>> => {
  if(!isAbsolute(lockPath)) throw new SourceSnapshotError('INVALID_INPUT',{field:'lockPath'}); await mkdir(dirname(lockPath),{recursive:true}); const token=randomUUID();
  for(let attempt=0;attempt<2;attempt+=1){try{const handle=await open(lockPath,'wx',0o600); try{await handle.writeFile(JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}),'utf8');await handle.sync();}finally{await handle.close();} return async()=>{try{const value=JSON.parse(await readFile(lockPath,'utf8')) as {token?:unknown}; if(value.token===token)await unlink(lockPath);}catch(error){if(code(error)!=='ENOENT')throw error;}};}catch(error){if(code(error)!=='EEXIST')throw error; let current:unknown; try{current=JSON.parse(await readFile(lockPath,'utf8'));}catch{current=undefined;} const pid=typeof current==='object'&&current!==null&&'pid' in current?(current as {pid?:unknown}).pid:undefined; if(running(pid))throw new SourceSnapshotError('SNAPSHOT_LOCKED',{pid}); try{await unlink(lockPath);}catch(unlinkError){if(code(unlinkError)!=='ENOENT')throw unlinkError;}}}
  throw new SourceSnapshotError('SNAPSHOT_LOCKED');
};
