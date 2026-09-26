import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { prepareH8Arm } from '../../packages/repository-context/evaluation/h8-setup.mjs';

const tempRoot=resolve(import.meta.dirname,'../../.tmp');
test('H8 setup builds only the C index from packed runtime and task metadata',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const pack=await mkdtemp(resolve(tempRoot,'ab-eval-h8-setup-'));
  try{
    await mkdir(resolve(pack,'metadata/tasks'),{recursive:true});
    await mkdir(resolve(pack,'runtime/consumer/package/dist/node'),{recursive:true});
    await writeFile(resolve(pack,'metadata/tasks/task.json'),
      JSON.stringify({packages:['one','two']}));
    await writeFile(resolve(pack,'runtime/consumer/package/dist/node/cli.js'),'// fixture\n');
    const workDir=resolve(pack,'work-c');
    await mkdir(workDir);
    await mkdir(resolve(pack,'work-a'));
    const calls=[];
    const runner=async spec=>{calls.push(spec);return {status:0,
      stdout:'{"status":"ok"}\n',stderr:''};};
    await prepareH8Arm({packRoot:pack,workDir:resolve(pack,'work-a'),
      armRoot:resolve(pack,'arm-a'),
      arm:'A',taskId:'task',processRunner:runner});
    await prepareH8Arm({packRoot:pack,workDir,armRoot:resolve(pack,'arm-c'),
      arm:'C',taskId:'task',processRunner:runner});
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].args.filter(x=>x==='--scope').length,2);
    assert.ok(calls[0].args.includes('packages/one/src'));
    assert.ok(calls[0].args.includes('packages/two/src'));
    assert.equal(JSON.parse(await readFile(resolve(workDir,'tsconfig.json'),'utf8'))
      .compilerOptions.module,'NodeNext');
  }finally{await rm(pack,{recursive:true,force:true});}
});
