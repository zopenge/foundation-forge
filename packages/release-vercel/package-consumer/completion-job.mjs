import { appendFile, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const [control, proofPath, observations] = process.argv.slice(2);
const context = JSON.parse(process.env.FORGE_RELEASE_COMPLETION_CONTEXT ?? 'null');
const proof = JSON.parse(await readFile(proofPath, 'utf8'));
for (const key of ['sourceSha', 'configSha256', 'artifactSha256', 'deploymentId', 'productionUrl']) {
  if (!context || context[key] !== proof[key]) throw new Error(`production target not proved: ${key}`);
}
const lock = JSON.parse(await readFile(resolve(process.cwd(), '../run.lock'), 'utf8'));
const metadata = Object.fromEntries(['FORGE_RELEASE_URL', 'FORGE_RELEASE_COMMAND', 'FORGE_RELEASE_SHA', 'FORGE_RELEASE_PHASE',
  'FORGE_RELEASE_DEPLOYMENT_ID', 'FORGE_RELEASE_CONFIG_SHA256', 'FORGE_RELEASE_ARTIFACT_SHA256', 'FORGE_RELEASE_VERSION_URL']
  .map(key => [key, process.env[key]]));
await appendFile(observations, `${JSON.stringify({ context, cwd: process.cwd(), lockRunId: lock.runId, metadata })}\n`);
if (await readFile(control, 'utf8') === 'wait') await new Promise((accept, reject) => {
  const inspect = () => readFile(control, 'utf8').then(value => {
    if (value !== 'wait') { watcher.close(); accept(); }
  }, error => { watcher.close(); reject(error); });
  const watcher = watch(control, inspect);
  watcher.on('error', reject); inspect();
});
if (await readFile(control, 'utf8') === 'fail') process.exitCode = 23;
