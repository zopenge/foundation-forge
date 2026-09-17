import type { CatalogArtifact, CatalogReadBudget } from './read-catalog-contracts.js';
import type { SnapshotObjectBytes, SnapshotReadLimits, SnapshotTextReadResult } from './content-contracts.js';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { SourceSnapshotError } from './errors.js';
import { resolveSnapshotCatalog } from './read-catalog-resolve.js';
import { copySnapshotReadObjects, failSnapshotReadLimit, validateSnapshotReadLimits } from './read-budget.js';
import { calculateNormalizedTextIntegrity } from './text-integrity.js';
export interface CatalogTextReadResult extends SnapshotTextReadResult { readonly catalogDigest: string; readonly sourceBinding: 'caller-pinned-catalog'; }

/** 调用方先完成目录与 manifest 的交付核验并固定摘要；本次只读所需分片和正文。 */
export const readSnapshotCatalogText = async (
  root: CatalogArtifact, expectedDigest: string, path: string, artifacts: readonly CatalogArtifact[],
  objects: readonly SnapshotObjectBytes[], limits: SnapshotReadLimits, budget: CatalogReadBudget = {},
): Promise<CatalogTextReadResult> => {
  validateSnapshotReadLimits(limits);
  const resolved = await resolveSnapshotCatalog(root, expectedDigest, {kind:'path',path}, artifacts,
    {...budget,maxBytes:Math.min(budget.maxBytes ?? limits.maxTotalBytes,limits.maxTotalBytes)});
  if(resolved.status === 'needs-artifact') throw new SourceSnapshotError('OBJECT_MISSING',{path:resolved.requirement.path,scope:'catalog'});
  if(resolved.status === 'not-in-snapshot') throw new SourceSnapshotError('FILE_NOT_PACKED',{path,sourceExistence:'unknown'});
  const file=resolved.files[0];
  if(!file || resolved.files.length !== 1) throw new SourceSnapshotError('TEXT_DETAILS_INVALID',{path,field:'catalog-file'});
  if(file.formatVersion !== 2 || file.normalizedByteLength === undefined || file.normalizedSha256 === undefined) throw new SourceSnapshotError('TEXT_FORMAT_UNSUPPORTED',{path});
  if(file.normalizedByteLength > limits.maxFileBytes) failSnapshotReadLimit('maxFileBytes');
  const available=limits.maxTotalBytes-resolved.verifiedBytes;
  if(available <= 0) failSnapshotReadLimit('maxTotalBytes');
  const copies=copySnapshotReadObjects(file.objectRequirements,objects,{...limits,maxTotalBytes:available});
  for(const requirement of file.objectRequirements) {
    const bytes=copies.get(requirement.path);
    if(!bytes) throw new SourceSnapshotError('OBJECT_MISSING',{path:requirement.path});
    const actual=await calculateBytesIntegrity(bytes);
    if(actual.sha256 !== requirement.sha256 || actual.byteLength !== requirement.byteLength) throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH',{path:requirement.path});
  }
  const locators=[...file.locators].sort((a,b)=>a.segmentIndex-b.segmentIndex);
  const parts:string[]=[]; let offset=0; const decoder=new TextDecoder('utf-8',{fatal:true});
  for(const [index,locator] of locators.entries()) {
    const bytes=copies.get(locator.objectPath);
    if(!bytes || locator.segmentIndex !== index+1 || locator.segmentCount !== locators.length || locator.sourceByteOffset !== offset ||
      locator.bodyByteOffset > bytes.byteLength-locator.bodyByteLength || locator.bodyByteLength > file.normalizedByteLength-offset) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID',{path,field:'catalog-segments'});
    }
    try { parts.push(decoder.decode(bytes.subarray(locator.bodyByteOffset,locator.bodyByteOffset+locator.bodyByteLength))); }
    catch { throw new SourceSnapshotError('TEXT_INTEGRITY_MISMATCH',{path,reason:'invalid-utf8-body'}); }
    offset+=locator.bodyByteLength;
  }
  const text=parts.join(''); const integrity=await calculateNormalizedTextIntegrity(text);
  let lines=text.length > 0 && !text.endsWith('\n') ? 1 : 0;
  for(let i=0;i<text.length;i+=1) if(text.charCodeAt(i)===10) lines+=1;
  if(offset !== file.normalizedByteLength || integrity.normalizedByteLength !== file.normalizedByteLength ||
    integrity.normalizedSha256 !== file.normalizedSha256 || lines !== file.sourceLineCount) throw new SourceSnapshotError('TEXT_INTEGRITY_MISMATCH',{path});
  return Object.freeze({snapshotId:resolved.snapshotId,catalogDigest:resolved.catalogDigest,path,text,sourceSha256:file.sourceSha256,
    normalizedSha256:file.normalizedSha256,assurance:'normalized-text-verified' as const,sourceBinding:'caller-pinned-catalog' as const});
};
