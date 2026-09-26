import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { rebaseH8Candidate } from '../../packages/repository-context/evaluation/rebase-h8-candidate.mjs';
import { freezePack, validatePack } from '../ab-eval/manifest.mjs';
import { makeTarballFixture } from './ab-eval-tarball-fixture.mjs';

const tempRoot=resolve(import.meta.dirname,'../../.tmp');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
const packageJson={name:'fixture',version:'1.0.0',type:'module',
  bin:{fixture:'./dist/node/cli.js'},dependencies:{typescript:'6.0.3'}};
const archive=cli=>makeTarballFixture({
  'package/package.json':`${JSON.stringify(packageJson)}\n`,
  'package/dist/node/cli.js':cli,
  'package/dist/index.js':'export const ready=true;\n',
});

test('H8 候选换包从新真实 tarball 生成运行时并保留冻结任务',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-h8-rebase-'));
  try{
    const source=resolve(root,'source');
    const runtime=resolve(source,'runtime/consumer/package');
    await mkdir(resolve(runtime,'dist/node'),{recursive:true});
    await mkdir(resolve(runtime,'node_modules/typescript'),{recursive:true});
    await mkdir(resolve(source,'fixture'),{recursive:true});
    await writeFile(resolve(source,'candidate.tgz'),archive('old-cli\n'));
    await writeFile(resolve(runtime,'package.json'),`${JSON.stringify(packageJson)}\n`);
    await writeFile(resolve(runtime,'dist/node/cli.js'),'old-cli\n');
    await writeFile(resolve(runtime,'node_modules/typescript/package.json'),'{}\n');
    await writeFile(resolve(source,'fixture/input.txt'),'frozen task\n');
    await writeFile(resolve(source,'a.json'),'{}\n');
    await writeFile(resolve(source,'c.json'),'{}\n');
    await writeFile(resolve(source,'verify.mjs'),'process.exit(0);\n');
    const draft={schemaVersion:1,id:'source-pack',candidate:'candidate.tgz',
      client:{kind:'opencode',version:'1.18.30',model:'vendor/model',variant:'high',agent:'build'},
      configs:{A:'a.json',C:'c.json'},
      tasks:[{id:'task',fixture:'fixture',prompt:'Fix.',
        publicVerifier:'verify.mjs',hiddenVerifier:'verify.mjs'}],
      pairs:[{id:'pair-1',taskId:'task',order:'AC'}],
      concurrency:1,armTimeoutMs:600000,
      allowedTools:{A:['read'],C:['repository_context_investigate']}};
    await writeFile(resolve(source,'draft.json'),`${JSON.stringify(draft)}\n`);
    await freezePack({draftPath:resolve(source,'draft.json'),
      outputPath:resolve(source,'pack.json')});
    const candidate=resolve(root,'new-candidate.tgz');
    const bytes=archive('new-cli\n');
    await writeFile(candidate,bytes);

    const outputDir=resolve(root,'rebased');
    const result=await rebaseH8Candidate({manifestPath:resolve(source,'pack.json'),
      candidatePath:candidate,outputDir,id:'rebased-pack'});
    const checked=await validatePack(resolve(outputDir,'pack.json'));
    assert.equal(result.candidateSha256,sha(bytes));
    assert.equal(checked.manifest.id,'rebased-pack');
    assert.equal(checked.manifest.files['fixture/input.txt'],sha('frozen task\n'));
    assert.equal(await readFile(resolve(outputDir,'runtime/consumer/package/dist/node/cli.js'),'utf8'),
      'new-cli\n');
    assert.equal(await readFile(resolve(outputDir,'runtime/consumer/package/dist/index.js'),'utf8'),
      'export const ready=true;\n');
    assert.equal(await readFile(resolve(outputDir,'runtime/consumer/package/node_modules/typescript/package.json'),'utf8'),
      '{}\n');
    assert.equal(await readFile(resolve(source,'runtime/consumer/package/dist/node/cli.js'),'utf8'),
      'old-cli\n');
  }finally{await rm(root,{recursive:true,force:true});}
});
