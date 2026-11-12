import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import console from 'node:console';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const child = fileURLToPath(new URL('./durable-child.mjs', import.meta.url));
const run = (platform, action, root, value = '') => new Promise((resolve, reject) => {
  const processChild = spawn(process.execPath, [child, platform, action, root, value], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const output = [];
  let failure;
  processChild.stdout.on('data', chunk => output.push(chunk));
  processChild.stderr.on('data', chunk => output.push(chunk));
  processChild.once('error', error => { failure = error; });
  processChild.once('close', (code, signal) => failure ? reject(failure) : resolve({ code, signal, output: Buffer.concat(output).toString('utf8') }));
});

export async function verifyDurableFilesystem() {
  const platform = process.platform === 'win32' ? 'win32-ntfs' : 'linux';
  const root = await mkdtemp(join(process.cwd(), 'dur-'));
  try {
    for (const action of ['write', 'read']) {
      const result = await run(platform, action, root);
      assert.equal(result.code, 0, result.output);
      assert.equal(result.signal, null);
    }
    const outcomes = await Promise.allSettled(['first', 'second'].map(value => run(platform, 'race', root, value)));
    const results = outcomes.map(result => {
      if (result.status === 'rejected') throw result.reason;
      assert.equal(result.value.signal, null);
      assert.ok([0, 17].includes(result.value.code), result.value.output);
      return result.value;
    });
    assert.equal(results.filter(result => result.code === 0).length, 1);
    assert.equal(await readFile(join(root, 'state/winner'), 'utf8'), results[0].code === 0 ? 'first' : 'second');
    assert.deepEqual((await readdir(join(root, 'state'))).sort(), ['frozen', 'private', 'receipt', 'winner']);
    console.log(`durable-files consumer: ${platform}; native flush, process restart and exclusive race passed`);
  } finally { await rm(root, { recursive: true }); }
}
