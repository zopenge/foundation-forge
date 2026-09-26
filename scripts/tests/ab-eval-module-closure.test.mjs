import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { collectRelativeModuleClosure } from '../ab-eval/module-closure.mjs';

const tempRoot=resolve(import.meta.dirname,'../../.tmp');
test('module closure includes static imports and URL runtime dependencies',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-closure-'));
  try{
    await mkdir(resolve(root,'tool'));
    await writeFile(resolve(root,'tool/a.mjs'),
      "import { x } from './b.mjs';\nexport { x };\n");
    await writeFile(resolve(root,'tool/b.mjs'),
      "import fs from 'node:fs';\nnew URL('./loader.mjs',import.meta.url);\nexport const x=fs;\n");
    await writeFile(resolve(root,'tool/loader.mjs'),'export default 1;\n');
    const paths=await collectRelativeModuleClosure({root,seeds:['tool/a.mjs']});
    assert.deepEqual(paths,['tool/a.mjs','tool/b.mjs','tool/loader.mjs']);
    await assert.rejects(()=>collectRelativeModuleClosure({root,
      seeds:['../escape.mjs']}),{code:'MODULE_PATH_OUTSIDE_ROOT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
