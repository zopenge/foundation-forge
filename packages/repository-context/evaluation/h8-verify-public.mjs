import { resolve } from 'node:path';
import process from 'node:process';

import { runFoundationTypeScript } from '../runtime/repository-context-lab/evaluation/foundation-ts-runner.mjs';

const [root]=process.argv.slice(2);
if(!root)throw new Error('PUBLIC_VERIFIER_ROOT_REQUIRED');
const result=await runFoundationTypeScript({
  script:resolve(root,'public-test.mjs'),cwd:root,timeoutMs:30000});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
process.exitCode=result.exitCode===0&&!result.timedOut?0:1;
