import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { TextEncoder } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildSnapshotReadCatalog, resolveSnapshotCatalog, verifySnapshotReadCatalog, readSnapshotCatalogText,
  buildSnapshotCoverage, resolveSnapshotCoverage, verifySnapshotCoverage,
  buildSnapshotProvenance, verifySnapshotProvenance, buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile,
} from '@openge/forge-source-snapshot';
import { prepareSnapshotWithProvenance, buildSnapshotCoverageFromPlan, buildSnapshotProvenanceFromPlan } from '@openge/forge-source-snapshot/node';
const bytes = text => new TextEncoder().encode(text);
async function sample(path='src/a.ts',text='const value=1;\n') {
  const staged=await stageSourceTextFile({path,group:'code',bytes:bytes(text)});
  const packed=await buildSourceTextPackage([staged],{targetObjectBytes:4096,maxObjectBytes:8192,maxObjectCount:10,maxObjectBytesTotal:100000,textFormatVersion:2});
  const manifest=await createTextSnapshotManifest({projectId:'reading-consumer',policyVersion:'1',publishedAt:1,repositories:[],textPackage:packed});
  return {manifest,packed};
}
const {manifest,packed}=await sample();
const catalog=await buildSnapshotReadCatalog(manifest);
assert.equal((await verifySnapshotReadCatalog(manifest,catalog)).fileCount,1);
assert.deepEqual(await buildSnapshotReadCatalog(manifest),catalog);
const located=await resolveSnapshotCatalog(catalog.root,catalog.root.sha256,{kind:'path',path:'src/a.ts'},catalog.artifacts);
assert.equal(located.status,'found');
const text=await readSnapshotCatalogText(catalog.root,catalog.root.sha256,'src/a.ts',catalog.artifacts,packed.objects.map(o=>({path:o.path,bytes:bytes(o.content)})),{maxObjectBytes:8192,maxFileBytes:100000,maxTotalBytes:1048576});
assert.equal(text.text,'const value=1;\n');
const options={requiredPaths:['src/a.ts'],profile:{profileId:'reference',snapshotId:manifest.snapshotId,preferredPaths:[],referencePaths:['src/a.ts']}};
const coverage=await buildSnapshotCoverage(manifest,options); assert.equal(coverage.summary.fullTextFiles,1);
assert.equal(resolveSnapshotCoverage(coverage,'src/a.ts').fullTextAvailable,true); await verifySnapshotCoverage(manifest,options,coverage);
const provenance=await buildSnapshotProvenance(manifest,{coverage,catalog}); assert.equal(provenance.captureMode,'unknown');
await verifySnapshotProvenance(manifest,{coverage,catalog},provenance);
const renamed=await sample('src/renamed.ts');
assert.deepEqual(renamed.packed.objects,packed.objects);
assert.notEqual((await buildSnapshotReadCatalog(renamed.manifest)).root.sha256,catalog.root.sha256);
const changed=await sample('src/a.ts','const value=2;\n');
assert.notEqual(changed.manifest.snapshotId,manifest.snapshotId);
assert.equal((await buildSnapshotReadCatalog((await sample()).manifest)).root.sha256,catalog.root.sha256);
const reference=await buildSnapshotReadCatalog(manifest,{profile:options.profile});
assert.notEqual(reference.root.sha256,catalog.root.sha256);
assert.deepEqual(manifest.objects,renamed.manifest.objects);
const work=join(process.cwd(),'.tmp'); await mkdir(work,{recursive:true});
const base=await mkdtemp(join(work,'reading-api-')); const sourceRoot=join(base,'source'); await mkdir(sourceRoot);
const git=args=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',sourceRoot,...args],{stdio:'pipe'});
let captured;
try {
  git(['init','--quiet']); await writeFile(join(sourceRoot,'entry.ts'),'export const entry=1;\n'); git(['add','entry.ts']); git(['commit','--quiet','-m','fixture']);
  const policy={textExtensions:['.ts']};
  const parameters={sourceRoot,workRoot:join(base,'spool'),projectId:'reading-node',policyVersion:'1',publishedAt:1,policy,groupForPath:()=> 'code',
    pack:{targetObjectBytes:4096,maxObjectBytes:8192,maxObjectCount:10,maxObjectBytesTotal:100000,textFormatVersion:2}};
  captured=await prepareSnapshotWithProvenance(parameters,{exporter:{id:'consumer',version:'1'}});
  assert.equal(captured.provenance.captureEvidence,'same-operation');
  const fromPlan=await buildSnapshotProvenanceFromPlan(captured.prepared.plan,{policy,policyVersion:'1'});
  assert.equal(fromPlan.provenance.captureEvidence,'supplied-records');
  const fromCoverage=await buildSnapshotCoverageFromPlan(captured.prepared.plan,{policy,policyVersion:'1',producer:'consumer'});
  assert.equal(fromCoverage.summary.fullTextFiles,1);
  assert.equal(await readFile(join(sourceRoot,'entry.ts'),'utf8'),'export const entry=1;\n');
} finally { await captured?.prepared.dispose(); await rm(base,{recursive:true,force:true}); }
console.log('Installed reading APIs: catalog/coverage/provenance/cold-text/incremental/Node PASS');
