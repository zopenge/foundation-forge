import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import test from 'node:test';

import { freezePack, slicePack, validatePack } from '../ab-eval/manifest.mjs';
import { makeTarballFixture } from './ab-eval-tarball-fixture.mjs';

const repoRoot=resolve(import.meta.dirname,'../..');
const tempRoot=resolve(repoRoot,'.tmp');
const sha=value=>createHash('sha256').update(value).digest('hex').toUpperCase();

const withPack=async fn=>{
  await mkdir(tempRoot,{recursive:true});
  const dir=await mkdtemp(resolve(tempRoot,'ab-eval-manifest-'));
  if(!dir.startsWith(tempRoot+sep)) throw new Error('TEST_TEMP_OUTSIDE_WORKSPACE');
  try{
    await mkdir(resolve(dir,'fixture'),{recursive:true});
    await writeFile(resolve(dir,'fixture','source.txt'),'before\n');
    await writeFile(resolve(dir,'candidate.tgz'),makeTarballFixture());
    await writeFile(resolve(dir,'a.json'),'{}\n');
    await writeFile(resolve(dir,'c.json'),'{}\n');
    await writeFile(resolve(dir,'verify.mjs'),'process.exit(0);\n');
    const draft={schemaVersion:1,id:'portable-smoke',
      candidate:'candidate.tgz',
      client:{kind:'opencode',version:'1.18.30',model:'vendor/model',variant:'high',agent:'build'},
      configs:{A:'a.json',C:'c.json'},
      tasks:[{id:'task',fixture:'fixture',prompt:'Fix the fixture.',
        publicVerifier:'verify.mjs',hiddenVerifier:'verify.mjs'}],
      pairs:[{id:'pair-1',taskId:'task',order:'AC'}],
      concurrency:1,armTimeoutMs:600000,
      allowedTools:{A:['read'],C:['repository_context_investigate']}};
    await writeFile(resolve(dir,'draft.json'),JSON.stringify(draft,null,2)+'\n');
    await fn(dir,draft);
  }finally{await rm(dir,{recursive:true,force:true});}
};

test('frozen task pack validates after relocation with the same content hashes',async()=>withPack(async dir=>{
  const path=resolve(dir,'pack.json');
  const frozen=await freezePack({draftPath:resolve(dir,'draft.json'),outputPath:path});
  assert.equal(frozen.files['fixture/source.txt'],sha('before\n'));
  assert.equal((await validatePack(path)).manifest.id,'portable-smoke');
  const moved=resolve(dir,'relocated');
  await mkdir(moved);
  for(const name of ['candidate.tgz','a.json','c.json','verify.mjs','draft.json'])
    await cp(resolve(dir,name),resolve(moved,name));
  await cp(resolve(dir,'fixture'),resolve(moved,'fixture'),{recursive:true});
  await cp(path,resolve(moved,'pack.json'));
  assert.equal((await validatePack(resolve(moved,'pack.json'))).manifestSha256,
    sha(await readFile(path)));
}));

test('pack rejects changed files and escaping paths',async()=>withPack(async(dir,draft)=>{
  const path=resolve(dir,'pack.json');
  await freezePack({draftPath:resolve(dir,'draft.json'),outputPath:path});
  await writeFile(resolve(dir,'fixture','source.txt'),'changed\n');
  await assert.rejects(()=>validatePack(path),{code:'PACK_SOURCE_DRIFT'});
  const escaped={...draft,candidate:'../outside.tgz'};
  await writeFile(resolve(dir,'bad.json'),JSON.stringify(escaped));
  await assert.rejects(()=>freezePack({draftPath:resolve(dir,'bad.json'),
    outputPath:resolve(dir,'bad-pack.json')}),{code:'PACK_PATH_INVALID'});
}));

test('pack rejects an unlisted file added to a frozen fixture',async()=>withPack(async dir=>{
  const path=resolve(dir,'pack.json');
  await freezePack({draftPath:resolve(dir,'draft.json'),outputPath:path});
  await writeFile(resolve(dir,'fixture','extra.txt'),'unfrozen\n');
  await assert.rejects(()=>validatePack(path),{code:'PACK_SOURCE_DRIFT'});
}));

test('pack rejects a candidate that is not a real npm tarball',async()=>withPack(async dir=>{
  await writeFile(resolve(dir,'candidate.tgz'),'placeholder');
  await assert.rejects(()=>freezePack({draftPath:resolve(dir,'draft.json'),
    outputPath:resolve(dir,'pack.json')}),{code:'CANDIDATE_TARBALL_INVALID'});
}));

test('pack rejects an unlisted runtime file added after freezing',async()=>withPack(async dir=>{
  const path=resolve(dir,'pack.json');
  await freezePack({draftPath:resolve(dir,'draft.json'),outputPath:path});
  await writeFile(resolve(dir,'extra.mjs'),'process.exit(0);\n');
  await assert.rejects(()=>validatePack(path),{code:'PACK_SOURCE_DRIFT'});
}));

test('frozen pair selection creates a movable one-pair pack without source edits',
  async()=>withPack(async(dir,draft)=>{
    draft.pairs.push({id:'pair-2',taskId:'task',order:'CA'});
    draft.concurrency=2;
    await writeFile(resolve(dir,'draft.json'),JSON.stringify(draft));
    await freezePack({draftPath:resolve(dir,'draft.json'),
      outputPath:resolve(dir,'pack.json')});
    const candidate=(await validatePack(resolve(dir,'pack.json')))
      .manifest.files['candidate.tgz'];
    const outputDir=resolve(tempRoot,`${basename(dir)}-slice`);
    try{
      const sliced=await slicePack({manifestPath:resolve(dir,'pack.json'),
        outputDir,id:'portable-slice',pairIds:['pair-2']});
      assert.equal(sliced.manifest.pairs.length,1);
      assert.equal(sliced.manifest.pairs[0].order,'CA');
      assert.equal(sliced.manifest.concurrency,1);
      assert.equal(sliced.manifest.files['candidate.tgz'],candidate);
    }finally{await rm(outputDir,{recursive:true,force:true});}
  }));
