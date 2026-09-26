import { resolve } from 'node:path';
import process from 'node:process';

import { runFoundationTypeScript } from '../runtime/repository-context-lab/evaluation/foundation-ts-runner.mjs';

const [root,taskId]=process.argv.slice(2);
if(!root||!/^[a-z0-9][a-z0-9-]*$/u.test(taskId))
  throw new Error('HIDDEN_VERIFIER_ARGUMENT_INVALID');
const script=resolve(import.meta.dirname,'hidden',`${taskId}.mjs`);
const result=await runFoundationTypeScript({script,args:[root],cwd:root,timeoutMs:30000});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
process.exitCode=result.exitCode===0&&!result.timedOut?0:1;
