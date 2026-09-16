import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SourceSnapshotStorageLayoutOptions, SourceSnapshotPathCaseSensitivity } from './contracts.js';
import { SourceSnapshotError } from '../errors.js';
export interface ResolvedSourceSnapshotLayout {
  readonly entryFile: string;
  readonly ownerFile: string;
  readonly gcFile: string;
  readonly pinsFile: string;
  readonly protectedTopLevelDirectories: readonly string[];
  readonly pathCaseSensitivity: SourceSnapshotPathCaseSensitivity;
}
const rootName = (value: string, field: string): string => {
  try { validatePortableRelativePath(value); } catch { throw new SourceSnapshotError('INVALID_INPUT',{field}); }
  if (value.includes('/')) throw new SourceSnapshotError('INVALID_INPUT',{field});
  return value;
};
export const resolveStorageLayout = (options: SourceSnapshotStorageLayoutOptions): ResolvedSourceSnapshotLayout => {
  const entryFile=rootName(options.entryFile??'00-SOURCE-SNAPSHOT.md','entryFile');
  const ownerFile=rootName(options.ownerFile??'.source-snapshot-owner.json','ownerFile');
  const gcFile=rootName(options.gcFile??'.source-snapshot-gc.json','gcFile');
  const pinsFile=rootName(options.pinsFile??'.source-snapshot-pins.json','pinsFile');
  if(new Set([entryFile,ownerFile,gcFile,pinsFile]).size!==4||[entryFile,ownerFile,gcFile,pinsFile].some(value=>['objects','snapshots'].includes(value))) throw new SourceSnapshotError('INVALID_INPUT',{field:'layout'});
  const protectedNames=[...(options.protectedTopLevelDirectories??[])].map(value=>rootName(value,'protectedTopLevelDirectories'));
  const folded=new Set<string>(); for(const value of protectedNames){const key=value.toLowerCase(); if(folded.has(key)||['objects','snapshots',entryFile.toLowerCase(),ownerFile.toLowerCase(),gcFile.toLowerCase(),pinsFile.toLowerCase()].includes(key)) throw new SourceSnapshotError('INVALID_INPUT',{field:'protectedTopLevelDirectories'}); folded.add(key);}
  const pathCaseSensitivity=options.pathCaseSensitivity??(process.platform==='win32'?'case-insensitive':'case-sensitive');
  if(pathCaseSensitivity!=='case-sensitive'&&pathCaseSensitivity!=='case-insensitive') throw new SourceSnapshotError('INVALID_INPUT',{field:'pathCaseSensitivity'});
  return Object.freeze({entryFile,ownerFile,gcFile,pinsFile,protectedTopLevelDirectories:Object.freeze(protectedNames.sort()),pathCaseSensitivity});
};
