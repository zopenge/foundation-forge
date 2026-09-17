import { expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import { buildSnapshotReadCatalog } from '../src/read-catalog.js';
import { readSnapshotCatalogText } from '../src/catalog-text-reader.js';
const limits = { maxObjectBytes:8192, maxFileBytes:32768, maxTotalBytes:1048576 };
async function fixture(text = '第一行\r\n第二行🙂', version: 1 | 2 = 2) {
  const staged = await stageSourceTextFile({ path:'src/中文.ts', group:'code', bytes:new TextEncoder().encode(text) });
  const packed = await buildSourceTextPackage([staged], { targetObjectBytes:2048, maxObjectBytes:4096, maxObjectCount:100, maxObjectBytesTotal:100000, textFormatVersion:version });
  const manifest = await createTextSnapshotManifest({ projectId:'catalog-reader', policyVersion:'1', publishedAt:1, repositories:[], textPackage:packed });
  const catalog = await buildSnapshotReadCatalog(manifest);
  const objects = packed.objects.map(object => ({ path:object.path, bytes:new TextEncoder().encode(object.content) }));
  return { catalog, objects, manifest };
}
test.each(['', '第一行\r\n第二行🙂', 'a\n'.repeat(9000)])('reads pinned catalog text without accepting or loading a complete manifest', async text => {
  const {catalog, objects, manifest} = await fixture(text);
  const result = await readSnapshotCatalogText(catalog.root, catalog.root.sha256, 'src/中文.ts', catalog.artifacts, objects, limits);
  expect(result.text).toBe(text.replaceAll('\r\n','\n'));
  expect(result.snapshotId).toBe(manifest.snapshotId);
  expect(result.catalogDigest).toBe(catalog.root.sha256);
  expect(result.sourceBinding).toBe('caller-pinned-catalog');
  expect(result.assurance).toBe('normalized-text-verified');
});
test('rejects a wrong root pin, missing shard, corrupt object, extra object and absent source', async () => {
  const {catalog, objects} = await fixture();
  const read = (path='src/中文.ts', parts=catalog.artifacts, bytes=objects, digest=catalog.root.sha256) => readSnapshotCatalogText(catalog.root,digest,path,parts,bytes,limits);
  await expect(read('src/中文.ts',catalog.artifacts,objects,'f'.repeat(64))).rejects.toMatchObject({code:'OBJECT_INTEGRITY_MISMATCH'});
  await expect(read('src/中文.ts',[])).rejects.toMatchObject({code:'OBJECT_MISSING'});
  await expect(read('none.ts')).rejects.toMatchObject({code:'FILE_NOT_PACKED'});
  const bad = objects.map(object=>({...object,bytes:Uint8Array.from(object.bytes,v=>v^1)}));
  await expect(read('src/中文.ts',catalog.artifacts,bad)).rejects.toMatchObject({code:'OBJECT_INTEGRITY_MISMATCH'});
  await expect(read('src/中文.ts',catalog.artifacts,[...objects,{path:'objects/extra.md',bytes:new Uint8Array(1)}])).rejects.toMatchObject({code:'OBJECT_CONFLICT'});
});
test('applies total read budget to directory plus source objects rather than source alone', async () => {
  const {catalog,objects} = await fixture();
  const totalSourceBytes=objects.reduce((sum,object)=>sum+object.bytes.length,0);
  await expect(readSnapshotCatalogText(catalog.root,catalog.root.sha256,'src/中文.ts',catalog.artifacts,objects,{...limits,maxTotalBytes:totalSourceBytes})).rejects.toMatchObject({code:'TEXT_READ_LIMIT_EXCEEDED'});
});
test('legacy text cannot be labeled as normalized-text verified through a catalog', async () => {
  const {catalog,objects} = await fixture('old\n',1);
  await expect(readSnapshotCatalogText(catalog.root,catalog.root.sha256,'src/中文.ts',catalog.artifacts,objects,limits)).rejects.toMatchObject({code:'TEXT_FORMAT_UNSUPPORTED'});
});
