import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import * as h8 from '../../packages/repository-context/evaluation/export-h8-pack.mjs';

const { assertFrozenTaskSource }=h8;

const sha=value=>createHash('sha256').update(value).digest('hex').toUpperCase();
const tempRoot=resolve(import.meta.dirname,'../../tmp');
test('H8 history export requires explicit legacy workspace opt-in before reading inputs',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'h8-explicit-history-'));
  const outputDir=resolve(root,'pack');
  try{
    for(const legacyWorkspace of [undefined,false,'true'])
      await assert.rejects(h8.exportH8Pack({outputDir,clientVersion:'1.18.30',
        packetPath:resolve(root,'not-created.json'),legacyWorkspace}),
      {code:'H8_LEGACY_ARCHIVE_REQUIRED'});
    const cli=spawnSync(process.execPath,[resolve(import.meta.dirname,
      '../../packages/repository-context/evaluation/export-h8-pack.mjs'),
    '--out',outputDir,'--client-version','1.18.30'],
    {encoding:'utf8',windowsHide:true});
    assert.equal(cli.status,1);
    assert.match(cli.stderr,/H8_LEGACY_ARCHIVE_REQUIRED/u);
    await assert.rejects(lstat(outputDir),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('H8 exporter rejects changed frozen public verifier',async()=>{
  await mkdir(tempRoot,{recursive:true});
  const root=await mkdtemp(resolve(tempRoot,'ab-eval-h8-export-'));
  try{
    const base=resolve(root,'base');
    await mkdir(base);
    await writeFile(resolve(base,'public-test.mjs'),'original\n');
    const manifest=resolve(root,'manifest.json');
    const hidden=resolve(root,'hidden.mjs');
    await writeFile(manifest,'{}\n');
    await writeFile(hidden,'hidden\n');
    const expected={manifestSha256:sha('{}\n'),
      publicTestSha256:sha('original\n'),
      hiddenVerifierSha256:sha('hidden\n')};
    await assertFrozenTaskSource({baseRoot:base,manifestPath:manifest,
      hiddenPath:hidden,expected});
    await writeFile(resolve(base,'public-test.mjs'),'changed\n');
    await assert.rejects(()=>assertFrozenTaskSource({baseRoot:base,
      manifestPath:manifest,hiddenPath:hidden,expected}),
    {code:'H8_TASK_FREEZE_DRIFT'});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('H8 evaluation exposes only the edit tool that automatically runs the public test',()=>{
  assert.equal(typeof h8.h8ToolPolicy,'function');
  const a=h8.h8ToolPolicy('A');
  const c=h8.h8ToolPolicy('C');
  assert.deepEqual(a.allowedTools,[
    'read','glob','grep','formal_task_replace_text']);
  assert.deepEqual(c.allowedTools,[
    'formal_task_replace_text',
    'repository_context_investigate','repository_context_read',
    'repository_context_continue']);
  assert.deepEqual(Object.keys(a.toolContract.mcp.formal_task),['replace_text']);
  assert.deepEqual(Object.keys(c.toolContract.mcp.formal_task),['replace_text']);
  assert.deepEqual(Object.keys(c.toolContract.mcp.repository_context),
    ['investigate','read','continue']);
  for(const policy of [a,c]){
    assert.equal(policy.permission['*'],'deny');
    for(const name of policy.allowedTools)
      assert.equal(policy.permission[name],'allow');
    assert.equal(policy.permission.todowrite,undefined);
    assert.equal(policy.permission.formal_task_run_public_test,undefined);
    assert.equal(policy.permission.apply_patch,undefined);
  }
});
